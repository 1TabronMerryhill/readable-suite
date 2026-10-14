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
 * Business is resolved from the called number (Twilio number map) or
 * from the business_ref parameter.
 */

const { createClient } = require("@supabase/supabase-js");
const { normalizePhone } = require("./station-lib");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RETELL_SECRET = process.env.RETELL_FUNCTION_SECRET;

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

/* Resolve business from called number or explicit ref */
async function resolveBusiness(supabase, event) {
  // Try explicit business_ref first
  const ref = event.business_ref;
  if (ref) {
    const { data } = await supabase
      .from("dm_businesses")
      .select("id, name, slug, phone_number, address, hours_text, station_data, status")
      .or(`slug.eq.${ref},id.eq.${ref}`)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }

  // Try called number from Retell payload
  const calledNumber = event.called_number || event.to_number;
  if (calledNumber) {
    const normalized = normalizePhone(calledNumber);
    const { data } = await supabase
      .from("dm_businesses")
      .select("id, name, slug, phone_number, address, hours_text, station_data, status")
      .eq("phone_number", normalized)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    if (data) return data;
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

async function getPackages(supabase, businessId) {
  const { data } = await supabase
    .from("dm_packages")
    .select("id, name, description, base_price_cents, serves_min, serves_max")
    .eq("business_id", businessId)
    .eq("active", true)
    .order("base_price_cents");
  return (data || []).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.base_price_cents != null ? (p.base_price_cents / 100).toFixed(2) : null,
    price_display: p.base_price_cents != null ? `$${(p.base_price_cents / 100).toFixed(2)}` : "custom quoted",
    serves: p.serves_min && p.serves_max ? `${p.serves_min}-${p.serves_max} people` : null,
  }));
}

exports.handler = async (event) => {
  // Auth check
  const secret = event.headers["x-retell-secret"] || event.headers["X-Retell-Secret"];
  if (RETELL_SECRET && secret !== RETELL_SECRET) {
    return json(401, { ok: false, error: "bad_secret" });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "bad_json" });
  }

  // Retell sends function name and args; also handle direct action param
  const action = body.action || body.function_name || (body.name || "").replace(/^station_/, "");
  const args = body.args || body.arguments || body.parameters || {};

  const supabase = getSupabase();
  if (!supabase) {
    return json(500, { ok: false, error: "no_database" });
  }

  const business = await resolveBusiness(supabase, { ...body, ...args });
  if (!business) {
    return json(404, { ok: false, error: "business_not_found" });
  }

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
      const packages = await getPackages(supabase, business.id);
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
      // Validate and create order
      const items = args.items || [];
      if (!items.length) {
        return json(400, { ok: false, error: "no_items", message: "No items specified for order." });
      }

      // For voice orders without buyer email, queue for human review
      // (Full order flow with Stripe etc. to be implemented)
      const { data: order, error } = await supabase
        .from("dm_orders")
        .insert({
          business_id: business.id,
          items: items,
          status: "pending_review",
          channel: "voice",
          caller_phone: normalizePhone(args.caller_phone || body.caller_phone || ""),
          notes: args.notes || "Voice order via Retell",
        })
        .select("id")
        .single();

      if (error) {
        return json(500, { ok: false, error: "order_failed", message: error.message });
      }

      return json(200, {
        ok: true,
        order_id: order.id,
        message: "Order received and queued for confirmation.",
      });
    }

    default:
      return json(400, {
        ok: false,
        error: "unknown_action",
        message: `Unknown action: ${action}. Available: get_menu, get_packages, get_hours, get_info, place_order.`,
      });
  }
};
