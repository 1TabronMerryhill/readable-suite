/* OpenLine gatekeeper confirm: tap-to-confirm for voice order tickets.
 *
 * GET /.netlify/functions/confirm-order?t=<confirm_token>&g=<gatekeeper_id>
 *
 * No login. The token is a 256-bit random minted per order at place_order
 * time; the gatekeeper id attributes WHO confirmed. Idempotent: re-taps show
 * who already confirmed. On first confirm, the customer gets a confirmation
 * text and the ticket records confirmed_by_name + confirmed_at.
 */

const { normalizePhone, sendSms } = require("./station-lib");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://evmynxxvyafvnreaudpr.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REST = SUPABASE_URL + "/rest/v1";

function headers() {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
    "Content-Type": "application/json",
  };
}

async function sbGet(table, query) {
  const res = await fetch(`${REST}/${table}?${query}`, { headers: headers() });
  if (!res.ok) throw new Error(`GET ${table} ${res.status}`);
  return res.json();
}

async function sbPatch(table, id, patch) {
  const res = await fetch(`${REST}/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`PATCH ${table} ${res.status}`);
  return res.json();
}

function page(title, heading, body) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:48px auto;padding:0 20px;color:#1a1a1a}
h1{font-size:24px;margin-bottom:8px}.card{border:1px solid #e2e2e2;border-radius:12px;padding:20px;margin-top:16px}
.muted{color:#666;font-size:14px}.ok{color:#0a7a3d}</style></head>
<body><h1>${heading}</h1><div class="card">${body}</div>
<p class="muted">OpenLine order confirm</p></body></html>`,
  };
}

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const token = qs.t || "";
  const gkId = qs.g || "";
  if (!token || !gkId) {
    return page("Invalid link", "This confirm link is incomplete.",
      `<p class="muted">Ask for a fresh ticket text.</p>`);
  }

  let orders;
  try {
    orders = await sbGet("dm_orders",
      `select=id,business_id,items,total_cents,fulfillment,fulfillment_type,status,confirmed_by_name,confirmed_at,caller_phone&confirm_token=eq.${encodeURIComponent(token)}&limit=1`);
  } catch (e) {
    console.error("confirm-order lookup failed:", e.message);
    return page("Error", "Could not look up this ticket.", `<p class="muted">Try again in a minute.</p>`);
  }
  const order = orders && orders[0];
  if (!order) {
    return page("Not found", "This ticket was not found.",
      `<p class="muted">It may have been cancelled.</p>`);
  }

  // Already confirmed: say who, don't double-notify.
  if (order.confirmed_at) {
    return page("Already confirmed",
      `Confirmed by ${order.confirmed_by_name || "the shop"}.`,
      `<p class="muted">No need to tap again.</p>`);
  }

  // Attribute: the gatekeeper whose link was tapped.
  let gkName = "the shop";
  try {
    const gks = await sbGet("dm_gatekeepers",
      `select=id,name,business_id,is_active&id=eq.${encodeURIComponent(gkId)}&limit=1`);
    const gk = gks && gks[0];
    if (!gk || !gk.is_active || gk.business_id !== order.business_id) {
      return page("Not authorized",
        "This link does not match an active gatekeeper for this order.",
        `<p class="muted">Check with the shop.</p>`);
    }
    gkName = gk.name;
  } catch (e) {
    console.error("confirm-order gatekeeper check failed:", e.message);
    return page("Error", "Could not verify this link.", `<p class="muted">Try again in a minute.</p>`);
  }

  const now = new Date().toISOString();
  try {
    await sbPatch("dm_orders", order.id, {
      status: "confirmed",
      confirmed_by_name: gkName,
      confirmed_by_gatekeeper_id: gkId,
      confirmed_at: now,
    });
  } catch (e) {
    console.error("confirm-order patch failed:", e.message);
    return page("Error", "Could not confirm this ticket.", `<p class="muted">Try again in a minute.</p>`);
  }

  // Customer confirmation text.
  try {
    const to = normalizePhone(order.caller_phone || "");
    if (to) {
      const items = (order.items || []).map((it) => `${it.quantity || it.qty || 1}x ${it.name || "item"}`).join(", ").slice(0, 100);
      const kind = order.fulfillment_type === "preorder" ? "pre-order" : "order";
      await sendSms(to, `Your ${kind} (${items}) is confirmed and being prepared. Thank you.`);
    }
  } catch (e) {
    console.error("confirm-order customer SMS failed:", e.message);
  }

  console.log("confirm-order: confirmed", order.id, "by", gkName);
  return page("Confirmed", `Order confirmed. Thanks, ${gkName}.`,
    `<p class="ok">The customer has been texted.</p>`);
};
