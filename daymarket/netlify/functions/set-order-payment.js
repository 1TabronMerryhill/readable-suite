/* DayMarket — attach a Stripe Checkout Session to an order.
   POST /.netlify/functions/set-order-payment
   Body: { order_id, payment_url, stripe_session_id }
   Only writes payment_url/stripe_session_id on unpaid orders. Never touches
   amounts or statuses. The checkout session itself is created via the
   operator's Stripe dashboard/MCP; this function just links it.
*/

const SUPABASE_URL = "https://evmynxxvyafvnreaudpr.supabase.co";

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

async function sb(serviceKey, method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return json(500, { ok: false, error: "not_configured" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad_json" }); }
  const orderId = String(body.order_id || "");
  const paymentUrl = String(body.payment_url || "");
  const sessionId = String(body.stripe_session_id || "");
  if (!orderId || !paymentUrl.startsWith("https://checkout.stripe.com/") || !sessionId.startsWith("cs_")) {
    return json(400, { ok: false, error: "bad_input" });
  }

  // Only attach to unpaid orders.
  const existing = await sb(serviceKey, "GET", `/dm_orders?id=eq.${encodeURIComponent(orderId)}&select=id,payment_status`);
  const order = existing.status === 200 && existing.data && existing.data[0];
  if (!order) return json(404, { ok: false, error: "order_not_found" });
  if (order.payment_status === "paid") return json(409, { ok: false, error: "already_paid" });

  const up = await sb(serviceKey, "PATCH", `/dm_orders?id=eq.${encodeURIComponent(orderId)}`, {
    payment_url: paymentUrl,
    stripe_session_id: sessionId,
  });
  if (up.status !== 200) return json(500, { ok: false, error: "update_failed" });
  return json(200, { ok: true, order_id: orderId });
};
