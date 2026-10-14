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

const { normalizePhone } = require("./station-lib");

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
  if (!res.ok) return null;
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

/* Resolve business from slug/ref or called number */
async function resolveBusiness(event) {
  const ref = event.business_ref;
  if (ref) {
    const rows = await sbGet(
      "dm_businesses",
      `select=id,name,slug,phone_number,address,hours_text,station_data,status&or=(slug.eq.${encodeURIComponent(ref)},id.eq.${encodeURIComponent(ref)})&status=eq.active&limit=1`
    );
    if (rows && rows.length) return rows[0];
  }

  const calledNumber = event.called_number || event.to_number;
  if (calledNumber) {
    const normalized = normalizePhone(calledNumber);
    const rows = await sbGet(
      "dm_businesses",
      `select=id,name,slug,phone_number,address,hours_text,station_data,status&phone_number=eq.${encodeURIComponent(normalized)}&status=eq.active&limit=1`
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
  const rows = await sbGet(
    "dm_packages",
    `select=id,name,description,base_price_cents,serves_min,serves_max&business_id=eq.${encodeURIComponent(businessId)}&active=eq.true&order=base_price_cents`
  );
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
        return json(200, {
          ok: true,
          business: business.name,
          hours: business.hours_text || "Hours not listed.",
        });
      }

      case "get_info": {
        return json(200, {
          ok: true,
          business: business.name,
          address: business.address || "Address not listed.",
          phone: business.phone_number || "Phone not listed.",
          hours: business.hours_text || "Hours not listed.",
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

        return json(200, {
          ok: true,
          order_id: order.id,
          fulfillment: fulfillment,
          delivery_fee: (deliveryFeeCents / 100).toFixed(2),
          message: fulfillment === "delivery"
            ? `Order received for delivery. Delivery fee is $${(deliveryFeeCents / 100).toFixed(2)}.`
            : "Order received for pickup.",
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
          message: `Unknown action: ${action}. Available: get_menu, get_packages, get_hours, get_info, place_order, create_package, get_delivery_fee.`,
        });
    }
  } catch (e) {
    return json(500, { ok: false, error: "action_failed", message: e.message });
  }
};
