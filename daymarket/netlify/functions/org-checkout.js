/* DayMarket org membership checkout — POST /.netlify/functions/org-checkout
 *
 * Authed org user only. Creates a Stripe Checkout Session in subscription
 * mode for the $49/mo org membership (price id from DAYMARKET_ORG_PRICE_ID).
 * The webhook (daymarket-webhook.js) activates the membership on payment.
 * An already-active org gets already_active instead of a second session.
 *
 * Response: { ok: true, url } — the client redirects the browser there.
 *
 * Env: SUPABASE_SERVICE_KEY, STRIPE_SECRET_KEY, DAYMARKET_ORG_PRICE_ID
 * (all set in the Netlify dashboard, never committed)
 */

const SUPABASE_URL = "https://evmynxxvyafvnreaudpr.supabase.co";
const ACCOUNT_URL = "https://daymarket.tabronmerryhill.com/account/";

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

async function getCaller(token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: token, Authorization: "Bearer " + token },
  });
  if (!res.ok) return null;
  return res.json();
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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.DAYMARKET_ORG_PRICE_ID;
  if (!serviceKey || !stripeKey || !priceId) {
    return json(503, { ok: false, error: "billing_not_configured" });
  }

  const auth = (event.headers.authorization || event.headers.Authorization || "");
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { ok: false, error: "sign_in_required" });
  const caller = await getCaller(token);
  if (!caller || !caller.id) return json(401, { ok: false, error: "sign_in_required" });

  const m = await sbRest(serviceKey, "GET", `/dm_members?id=eq.${caller.id}&select=id,pass_type,pass_status,stripe_customer_id`);
  const member = m.data && m.data[0];
  if (!member || member.pass_type !== "organization") {
    return json(403, { ok: false, error: "not_organization" });
  }
  if (member.pass_status === "active") {
    return json(200, { ok: false, error: "already_active" });
  }

  const params = new URLSearchParams();
  params.append("mode", "subscription");
  params.append("line_items[0][price]", priceId);
  params.append("line_items[0][quantity]", "1");
  params.append("success_url", ACCOUNT_URL + "?org_billing=success");
  params.append("cancel_url", ACCOUNT_URL + "?org_billing=canceled");
  params.append("metadata[org_id]", caller.id);
  params.append("metadata[type]", "org_membership");
  if (member.stripe_customer_id) params.append("customer", member.stripe_customer_id);
  else params.append("customer_email", caller.email || "");

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + stripeKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const session = await res.json();
  if (!res.ok || !session.url) {
    return json(502, { ok: false, error: "stripe_failed" });
  }
  return json(200, { ok: true, url: session.url });
};
