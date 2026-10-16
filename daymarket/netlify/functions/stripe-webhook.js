/* DayMarket — Stripe webhook: payment confirmation (readiness item 2).
   POST /.netlify/functions/stripe-webhook

   Verifies the Stripe-Signature header against STRIPE_WEBHOOK_SECRET, then on
   checkout.session.completed marks the matching dm_orders row paid
   (looked up by stripe_session_id). Idempotent: already-paid orders are
   acknowledged without duplicate writes. All other event types get a 200
   and are ignored.

   Security notes:
   - Only a signed webhook flips payment_status. Query params are never read.
   - No secret configured -> 500, nothing is processed.
   - Verification failures are logged with the Stripe event id only.
     No secrets, no raw bodies, no customer data in logs.

   Staging (not done here):
   - Milly registers https://daymarket.tabronmerryhill.com/.netlify/functions/stripe-webhook
     in his Stripe dashboard (Developers -> Webhooks, event: checkout.session.completed)
     and pastes the signing secret into Netlify env vars as STRIPE_WEBHOOK_SECRET.
   - Then we run a live test payment.
*/

const crypto = require("crypto");

const SUPABASE_URL = "https://evmynxxvyafvnreaudpr.supabase.co";
const TOLERANCE_SECONDS = 300; // Stripe's recommended replay window

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

/* ---------- Supabase REST (service role, server-side only) ---------- */

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
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

/* ---------- Stripe signature verification ---------- */

function getRawBody(event) {
  // Signature verification needs the exact bytes Stripe signed.
  if (event.isBase64Encoded) return Buffer.from(event.body || "", "base64");
  return Buffer.from(event.body || "", "utf8");
}

function getSignatureHeader(event) {
  const h = event.headers || {};
  return h["stripe-signature"] || h["Stripe-Signature"] || null;
}

// Returns { ok: true } or { ok: false, reason }.
function verifySignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return { ok: false, reason: "missing_signature" };
  // Header shape: t=<timestamp>,v1=<hex>[,v1=<hex>...]
  const parts = String(sigHeader).split(",");
  let timestamp = null;
  const v1s = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") timestamp = v;
    else if (k === "v1" && v) v1s.push(v);
  }
  if (!timestamp || v1s.length === 0) return { ok: false, reason: "malformed_signature" };

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const signedPayload = Buffer.concat([
    Buffer.from(timestamp + ".", "utf8"),
    rawBody,
  ]);
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest();
  for (const v1 of v1s) {
    let candidate;
    try {
      candidate = Buffer.from(v1, "hex");
    } catch {
      continue;
    }
    if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "bad_signature" };
}

/* ---------- handler ---------- */

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!webhookSecret || !serviceKey) {
    console.error("stripe-webhook: not configured (missing STRIPE_WEBHOOK_SECRET or SUPABASE_SERVICE_KEY)");
    return json(500, { ok: false, error: "not_configured" });
  }

  const rawBody = getRawBody(event);
  const check = verifySignature(rawBody, getSignatureHeader(event), webhookSecret);
  if (!check.ok) {
    console.error("stripe-webhook: signature rejected", check.reason);
    return json(400, { ok: false, error: "invalid_signature" });
  }

  let evt;
  try {
    evt = JSON.parse(rawBody.toString("utf8"));
  } catch {
    console.error("stripe-webhook: body is not JSON after valid signature");
    return json(400, { ok: false, error: "bad_json" });
  }
  const eventId = evt.id || "unknown";
  const eventType = evt.type || "unknown";

  if (eventType !== "checkout.session.completed") {
    // Acknowledge everything else so Stripe stops retrying. Not an error.
    return json(200, { ok: true, ignored: eventType });
  }

  const session = (evt.data && evt.data.object) || {};
  const sessionId = session.id || "";
  if (!sessionId.startsWith("cs_")) {
    console.error("stripe-webhook: completed event without a checkout session id", eventId);
    return json(400, { ok: false, error: "bad_session" });
  }

  // Find the order this checkout session was linked to (set-order-payment
  // writes stripe_session_id before the customer pays, so this must exist).
  const found = await sb(
    serviceKey,
    "GET",
    `/dm_orders?stripe_session_id=eq.${encodeURIComponent(sessionId)}&select=id,payment_status`
  );
  const order = found.status === 200 && found.data && found.data[0];
  if (!order) {
    // Data problem, not transient: log it loudly, ack so Stripe stops retrying.
    console.error("stripe-webhook: no order for session", eventId, sessionId);
    return json(200, { ok: false, error: "order_not_found" });
  }
  if (order.payment_status === "paid") {
    return json(200, { ok: true, already: "paid" });
  }

  const updated = await sb(serviceKey, "PATCH", `/dm_orders?id=eq.${encodeURIComponent(order.id)}`, {
    payment_status: "paid",
  });
  if (updated.status !== 200) {
    console.error("stripe-webhook: failed to mark order paid", eventId, order.id);
    return json(500, { ok: false, error: "db_error" });
  }

  console.log("stripe-webhook: order marked paid", eventId, order.id);
  return json(200, { ok: true, order_id: order.id });
};

// Exported for unit tests (node stripe-webhook.test via require).
exports._verifySignature = verifySignature;
exports._getRawBody = getRawBody;
