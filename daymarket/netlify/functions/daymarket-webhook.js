/* DayMarket Stripe webhook — POST /.netlify/functions/daymarket-webhook
 *
 * Verifies the Stripe signature (STRIPE_WEBHOOK_SECRET) and flips org
 * membership status: checkout.session.completed for an org_membership
 * session activates the org; subscription updates track past_due/active;
 * subscription deletion cancels. Unknown event types are acknowledged
 * without writes so Stripe stops retrying them.
 *
 * Env: SUPABASE_SERVICE_KEY, STRIPE_WEBHOOK_SECRET
 * (both set in the Netlify dashboard, never committed)
 */

const crypto = require("crypto");

const SUPABASE_URL = "https://evmynxxvyafvnreaudpr.supabase.co";

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

async function sbRest(serviceKey, method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: "Bearer " + serviceKey,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { res, text, data };
}

function verifySignature(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = {};
  header.split(",").forEach(function (kv) {
    const idx = kv.indexOf("=");
    if (idx > 0) parts[kv.slice(0, idx)] = kv.slice(idx + 1);
  });
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(t, 10)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(t + "." + payload, "utf8").digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(v1, "utf8"));
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!serviceKey || !secret) return json(500, { ok: false, error: "not_configured" });

  const payload = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");
  const sig = event.headers["stripe-signature"] || event.headers["Stripe-Signature"] || "";
  if (!verifySignature(payload, sig, secret)) {
    return json(400, { ok: false, error: "bad_signature" });
  }

  let ev = null;
  try { ev = JSON.parse(payload); } catch { return json(400, { ok: false, error: "bad_json" }); }
  const type = ev.type || "";
  const obj = ev.data && ev.data.object;

  try {
    if (type === "checkout.session.completed" && obj && obj.metadata && obj.metadata.type === "org_membership") {
      const orgId = obj.metadata.org_id;
      if (orgId) {
        await sbRest(serviceKey, "PATCH", `/dm_members?id=eq.${orgId}`, {
          stripe_customer_id: obj.customer || null,
          stripe_subscription_id: obj.subscription || null,
          pass_status: "active",
        });
      }
    } else if (type === "customer.subscription.updated" && obj) {
      const subId = obj.id;
      const found = await sbRest(serviceKey, "GET", `/dm_members?stripe_subscription_id=eq.${subId}&select=id`);
      const row = found.data && found.data[0];
      if (row) {
        const st = obj.status;
        const pass = st === "active" || st === "trialing" ? "active" : st === "past_due" ? "past_due" : null;
        if (pass) await sbRest(serviceKey, "PATCH", `/dm_members?id=eq.${row.id}`, { pass_status: pass });
      }
    } else if (type === "customer.subscription.deleted" && obj) {
      const subId = obj.id;
      const found = await sbRest(serviceKey, "GET", `/dm_members?stripe_subscription_id=eq.${subId}&select=id`);
      const row = found.data && found.data[0];
      if (row) await sbRest(serviceKey, "PATCH", `/dm_members?id=eq.${row.id}`, { pass_status: "canceled" });
    }
  } catch {
    // Acknowledge anyway: Stripe retries would only repeat a partial write.
  }
  return json(200, { ok: true });
};
