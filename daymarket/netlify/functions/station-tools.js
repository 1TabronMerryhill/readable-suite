/* Readable Station — data tools for voice agents.
 *
 * This is the FACT layer, not the BRAIN. The voice agent (Retell) handles
 * conversation naturally with its own LLM. It calls these tools to get
 * truthful business data: menu, prices, packages, hours, location.
 *
 * Each action returns structured data. The agent speaks naturally using
 * these facts. It must NEVER invent prices, items, or hours.
 *
 * Actions:
 *   get_menu     -> menu items with prices
 *   get_packages -> catering packages with prices
 *   get_hours    -> business hours
 *   get_info     -> address, phone, name
 *   place_order  -> create an order (validated)
 *
 * Auth: x-retell-secret header must match RETELL_FUNCTION_SECRET.
 * Uses Supabase REST API via fetch (no client dependency).
 */

const { normalizePhone, sendSms } = require("./station-lib");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://evmynxxvyafvnreaudpr.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RETELL_SECRET = process.env.RETELL_FUNCTION_SECRET;
const REST = SUPABASE_URL + "/rest/v1";

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

async function sbGet(table, query) {
  const url = `${REST}/${table}?${query}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) {
    // Never swallow backend errors as "not found": a 400/401 here used to
    // surface as a lying 404 business_not_found downstream. Throw instead so
    // the handler returns an honest 500 with the real cause.
    const txt = await res.text().catch(() => "");
    throw new Error(`Supabase GET ${table} failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function sbPost(table, row) {
  const url = `${REST}/${table}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase insert failed: ${txt}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

async function sbPatch(table, id, patch) {
  const url = `${REST}/${table}?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase patch failed: ${txt}`);
  }
}

/* Create a Stripe Checkout Session for an order */
async function createCheckoutSession({ amount_cents, order_id, business_name, customer_phone, description }) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY not configured");

  const params = new URLSearchParams({
    "payment_method_types[0]": "card",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][product_data][name]": description || `Order from ${business_name}`,
    "line_items[0][price_data][unit_amount]": String(amount_cents),
    "line_items[0][quantity]": "1",
    mode: "payment",
    success_url: `https://daymarket.tabronmerryhill.com/order/${order_id}?paid=1`,
    cancel_url: `https://daymarket.tabronmerryhill.com/order/${order_id}?cancelled=1`,
    "metadata[order_id]": order_id,
    "metadata[business]": business_name,
  });
  if (customer_phone) {
    params.set("metadata[customer_phone]", customer_phone);
  }

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Stripe API error: ${txt}`);
  }

  return res.json();
}

/* Resolve business from slug/ref or called number */
async function resolveBusiness(event) {
  const ref = event.business_ref;
  if (ref) {
    // PostgREST 400s the whole query if a non-UUID value lands in id.eq.
    // (invalid input syntax for type uuid). Only OR against id when the ref
    // is actually a UUID; otherwise match the slug alone.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
    const enc = encodeURIComponent(ref);
    const filter = isUuid ? `or=(slug.eq.${enc},id.eq.${enc})` : `slug=eq.${enc}`;
    const rows = await sbGet(
      "dm_businesses",
      `select=id,name,slug,phone_number,station_data,status&${filter}&status=eq.active&limit=1`
    );
    if (rows && rows.length) return rows[0];
  }

  const calledNumber = event.called_number || event.to_number;
  if (calledNumber) {
    const normalized = normalizePhone(calledNumber);
    const rows = await sbGet(
      "dm_businesses",
      `select=id,name,slug,phone_number,station_data,status&phone_number=eq.${encodeURIComponent(normalized)}&status=eq.active&limit=1`
    );
    if (rows && rows.length) return rows[0];
  }

  return null;
}

function formatMenu(business) {
  const items = (business.station_data && business.station_data.menu_items) || [];
  return items.map((i) => ({
    name: i.name,
    price: i.price_cents != null ? (i.price_cents / 100).toFixed(2) : null,
    price_display: i.price_cents != null ? `$${(i.price_cents / 100).toFixed(2)}` : "price not listed",
  }));
}

async function getPackages(businessId) {
  const FIELDS = "select=id,name,description,base_price_cents,serves_min,serves_max";
  // Business-specific packages first.
  let rows = await sbGet(
    "dm_packages",
    `${FIELDS}&business_id=eq.${encodeURIComponent(businessId)}&active=eq.true&order=base_price_cents`
  );
  if (!rows || !rows.length) {
    // Fallback: DayMarket's operator catalog (business_id NULL) belongs to
    // DayMarket itself and is sold across shops — e.g. the Meeting Box for
    // Milly's "ten people" call. Business-specific packages win when present.
    rows = await sbGet(
      "dm_packages",
      `${FIELDS}&business_id=is.null&active=eq.true&order=base_price_cents`
    );
  }
  return (rows || []).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.base_price_cents != null ? (p.base_price_cents / 100).toFixed(2) : null,
    price_display: p.base_price_cents != null ? `$${(p.base_price_cents / 100).toFixed(2)}` : "custom quoted",
    serves: p.serves_min && p.serves_max ? `${p.serves_min}-${p.serves_max} people` : null,
  }));
}

exports.handler = async (event) => {
  const secret = event.headers["x-retell-secret"] || event.headers["X-Retell-Secret"];
  if (RETELL_SECRET && secret !== RETELL_SECRET) {
    return json(401, { ok: false, error: "bad_secret" });
  }

  if (!SUPABASE_SERVICE_KEY) {
    return json(500, { ok: false, error: "no_database" });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "bad_json" });
  }

  const action = body.action || body.function_name || (body.name || "").replace(/^station_/, "");
  const args = body.args || body.arguments || body.parameters || {};
  const merged = { ...body, ...args };

  let business;
  try {
    business = await resolveBusiness(merged);
  } catch (e) {
    return json(500, { ok: false, error: "db_error", message: e.message });
  }
  if (!business) {
    return json(404, { ok: false, error: "business_not_found" });
  }

  try {
    switch (action) {
      case "get_menu": {
        const menu = formatMenu(business);
        return json(200, {
          ok: true,
          business: business.name,
          items: menu,
          summary: menu.map((i) => `${i.name} (${i.price_display})`).join(", "),
        });
      }

      case "get_packages": {
        const packages = await getPackages(business.id);
        return json(200, {
          ok: true,
          business: business.name,
          packages,
          summary: packages.length
            ? packages.map((p) => `${p.name} (${p.price_display})`).join(", ")
            : "No packages currently listed.",
        });
      }

      case "get_hours": {
        const hours = (business.station_data && business.station_data.hours) || "Hours not listed.";
        return json(200, {
          ok: true,
          business: business.name,
          hours: hours,
        });
      }

      case "get_info": {
        const sd = business.station_data || {};
        return json(200, {
          ok: true,
          business: business.name,
          address: sd.address || "Address not listed.",
          phone: business.phone_number || "Phone not listed.",
          hours: sd.hours || "Hours not listed.",
        });
      }

      case "place_order": {
        const items = args.items || merged.items || [];
        if (!items.length) {
          return json(400, { ok: false, error: "no_items", message: "No items specified for order." });
        }

        const fulfillment = args.fulfillment || merged.fulfillment || "pickup";
        const deliveryAddress = args.delivery_address || merged.delivery_address || null;

        // Calculate delivery fee: $35 through 3 dozen, $4 per dozen above
        let deliveryFeeCents = 0;
        if (fulfillment === "delivery") {
          if (!deliveryAddress) {
            return json(400, { ok: false, error: "no_address", message: "Delivery address is required for delivery orders." });
          }
          // Estimate dozens from items (rough: assume 12 units per dozen)
          let totalUnits = 0;
          for (const it of items) {
            totalUnits += parseInt(it.quantity || it.qty || 1, 10);
          }
          const dozens = Math.ceil(totalUnits / 12);
          const feeDollars = dozens <= 3 ? 35 : 35 + (dozens - 3) * 4;
          deliveryFeeCents = feeDollars * 100;
        }

        const order = await sbPost("dm_orders", {
          business_id: business.id,
          items: items,
          status: "pending_review",
          channel: "voice",
          caller_phone: normalizePhone(args.caller_phone || merged.caller_phone || ""),
          notes: (args.notes || merged.notes || "Voice order via Retell") +
            (fulfillment === "delivery" ? ` [DELIVERY] Address: ${deliveryAddress}. Fee: $${(deliveryFeeCents / 100).toFixed(2)}.` : " [PICKUP]"),
          fulfillment: fulfillment,
          delivery_address: deliveryAddress,
          delivery_fee_cents: deliveryFeeCents,
        });

        // Calculate order total for Stripe
        // Note: items don't have prices here yet — the agent should pass package_id or total
        // For now, create checkout when total_cents is provided
        const totalCents = parseInt(args.total_cents || merged.total_cents || 0, 10);
        let paymentUrl = null;
        let stripeSessionId = null;

        if (totalCents > 0 && process.env.STRIPE_SECRET_KEY) {
          try {
            const session = await createCheckoutSession({
              amount_cents: totalCents + deliveryFeeCents,
              order_id: order.id,
              business_name: business.name,
              customer_phone: normalizePhone(args.caller_phone || merged.caller_phone || ""),
              description: fulfillment === "delivery"
                ? `Order from ${business.name} (delivery)`
                : `Order from ${business.name} (pickup)`,
            });
            paymentUrl = session.url;
            stripeSessionId = session.id;

            // Attach payment info to order
            await sbPatch("dm_orders", order.id, {
              payment_url: paymentUrl,
              stripe_session_id: stripeSessionId,
            });

            // Actually text the payment link (this send never existed before).
            try {
              const smsTo = normalizePhone(args.caller_phone || merged.caller_phone || "");
              const sms = await sendSms(
                smsTo,
                `${business.name} order confirmed. Pay here: ${paymentUrl} DayMarket.`
              );
              if (sms.ok) console.log("SMS payment link sent", order.id, sms.sid);
              else console.error("SMS payment link skipped/failed", order.id, sms.skipped || sms.error);
            } catch (e) {
              // Log and continue — the order stands even if the text fails.
              console.error("SMS payment link error", order.id, e.message);
            }
          } catch (e) {
            // Log but don't fail the order — payment can be attached later
            console.error("Stripe checkout failed:", e.message);
          }
        }

        return json(200, {
          ok: true,
          order_id: order.id,
          fulfillment: fulfillment,
          delivery_fee: (deliveryFeeCents / 100).toFixed(2),
          payment_url: paymentUrl,
          message: fulfillment === "delivery"
            ? `Order received for delivery. Delivery fee is $${(deliveryFeeCents / 100).toFixed(2)}.${paymentUrl ? " Payment link sent." : ""}`
            : `Order received for pickup.${paymentUrl ? " Payment link sent." : ""}`,
        });
      }

      case "get_delivery_fee": {
        // Calculate delivery fee for a given quantity
        const dozens = parseInt(args.dozens || merged.dozens || 1, 10);
        const feeDollars = dozens <= 3 ? 35 : 35 + (dozens - 3) * 4;
        return json(200, {
          ok: true,
          dozens: dozens,
          fee: feeDollars.toFixed(2),
          fee_display: `$${feeDollars.toFixed(2)}`,
          message: `Delivery fee for ${dozens} dozen is $${feeDollars.toFixed(2)}.`,
        });
      }

      case "book_delivery": {
        // Delivery-only booking: business books DayMarket delivery for their own customer.
        // Customer pays just the delivery fee via Stripe. Business handles the food/order separately.
        const customerPhone = normalizePhone(args.customer_phone || merged.customer_phone || "");
        const deliveryAddress = args.delivery_address || merged.delivery_address || "";
        const dozens = parseInt(args.dozens || merged.dozens || 1, 10);
        const businessContact = args.business_contact || merged.business_contact || "";

        if (!customerPhone) {
          return json(400, { ok: false, error: "no_customer_phone", message: "Customer phone number is required to send the payment link." });
        }
        if (!deliveryAddress) {
          return json(400, { ok: false, error: "no_address", message: "Delivery address is required." });
        }

        const feeDollars = dozens <= 3 ? 35 : 35 + (dozens - 3) * 4;
        const feeCents = feeDollars * 100;

        // Create delivery record
        const delivery = await sbPost("dm_orders", {
          business_id: business.id,
          items: [{ name: "Delivery service", quantity: 1, dozens: dozens }],
          status: "delivery_booked",
          channel: "voice",
          caller_phone: customerPhone,
          fulfillment: "delivery",
          delivery_address: deliveryAddress,
          delivery_fee_cents: feeCents,
          notes: `Delivery-only booking via ${business.name}. Booked by: ${businessContact || "business"}. ${dozens} dozen. Customer pays delivery fee.`,
        });

        // Create Stripe checkout for delivery fee
        let paymentUrl = null;
        let stripeSessionId = null;
        if (process.env.STRIPE_SECRET_KEY) {
          try {
            const session = await createCheckoutSession({
              amount_cents: feeCents,
              order_id: delivery.id,
              business_name: business.name,
              customer_phone: customerPhone,
              description: `Delivery from ${business.name} (${dozens} dozen)`,
            });
            paymentUrl = session.url;
            stripeSessionId = session.id;
            await sbPatch("dm_orders", delivery.id, {
              payment_url: paymentUrl,
              stripe_session_id: stripeSessionId,
            });
            try {
              const sms = await sendSms(
                customerPhone,
                `Delivery from ${business.name} booked. Pay the $${feeDollars.toFixed(2)} fee here: ${paymentUrl} DayMarket.`
              );
              if (sms.ok) console.log("SMS delivery link sent", delivery.id, sms.sid);
              else console.error("SMS delivery link skipped/failed", delivery.id, sms.skipped || sms.error);
            } catch (e) {
              console.error("SMS delivery link error", delivery.id, e.message);
            }
          } catch (e) {
            console.error("Stripe checkout failed for delivery:", e.message);
          }
        }

        return json(200, {
          ok: true,
          delivery_id: delivery.id,
          fee: feeDollars.toFixed(2),
          fee_display: `$${feeDollars.toFixed(2)}`,
          payment_url: paymentUrl,
          customer_phone: customerPhone,
          message: paymentUrl
            ? `Delivery booked. Fee is $${feeDollars.toFixed(2)}. Payment link ready to send to customer.`
            : `Delivery booked. Fee is $${feeDollars.toFixed(2)}. Payment link not yet generated.`,
        });
      }

      case "create_package": {
        // Build a custom package from menu items with 10% premium
        const items = args.items || merged.items || [];
        if (!items.length) {
          return json(400, { ok: false, error: "no_items", message: "No items specified for package." });
        }

        const menu = formatMenu(business);
        const menuByName = {};
        for (const m of (business.station_data?.menu_items || [])) {
          menuByName[m.name.toLowerCase()] = m;
        }

        let baseCents = 0;
        const cleanItems = [];
        for (const it of items) {
          const menuItem = menuByName[String(it.name || "").toLowerCase()];
          if (!menuItem || menuItem.price_cents == null) continue;
          const qty = parseInt(it.quantity || it.qty || 1, 10);
          // If they said "dozen", convert to units (menu prices are per item)
          const isDozen = /dozen/i.test(it.unit || "") || qty >= 12;
          const units = isDozen && qty < 12 ? qty * 12 : qty;
          const lineTotal = units * menuItem.price_cents;
          baseCents += lineTotal;
          cleanItems.push({
            name: menuItem.name,
            qty: units,
            unit_price_cents: menuItem.price_cents,
          });
        }

        if (!baseCents || !cleanItems.length) {
          return json(400, { ok: false, error: "no_valid_items", message: "Could not match items to the menu." });
        }

        const premiumCents = Math.round(baseCents * 0.10);
        const shopPriceCents = baseCents + premiumCents;
        // DayMarket adds 15% on top. Shop nets the full shop price.
        const markupCents = Math.round(shopPriceCents * 0.15);
        const priceCents = shopPriceCents + markupCents;
        const itemList = cleanItems.map((i) => `${i.qty}x ${i.name}`).join(", ");
        const packageName = args.name || merged.name || `Custom Package`;

        const pkg = await sbPost("dm_packages", {
          business_id: business.id,
          name: packageName,
          description: `Custom bundle: ${itemList}. Built via phone.`,
          base_price_cents: priceCents,
          is_custom: true,
          active: true,
        });

        return json(200, {
          ok: true,
          package_id: pkg.id,
          package_name: packageName,
          price: (priceCents / 100).toFixed(2),
          price_display: `$${(priceCents / 100).toFixed(2)}`,
          shop_price: (shopPriceCents / 100).toFixed(2),
          items: itemList,
          message: `Created ${packageName} for $${(priceCents / 100).toFixed(2)}.`,
        });
      }

      default:
        return json(400, {
          ok: false,
          error: "unknown_action",
          message: `Unknown action: ${action}. Available: get_menu, get_packages, get_hours, get_info, place_order, create_package, get_delivery_fee, book_delivery.`,
        });
    }
  } catch (e) {
    return json(500, { ok: false, error: "action_failed", message: e.message });
  }
};
