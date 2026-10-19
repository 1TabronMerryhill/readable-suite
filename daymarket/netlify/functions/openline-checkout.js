/* OpenLine checkout: plan purchases + minute reload packs via Stripe Checkout.
 *
 * POST { plan: 'shared'|'dedicated', addons: ['reviews'], business: {name, contact, email, phone} }
 *   -> { url }  (Stripe Checkout: subscription + one-time setup as needed)
 * POST { sku: 'minutes-100', business_id }
 *   -> { url }  (one-time $25 for 100 extra minutes on the current cycle)
 *
 * The Stripe webhook (stripe-webhook.js) settles both via session metadata.
 */

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const SITE = "https://openline.tabronmerryhill.com";

const PRICES = {
  shared_monthly: 14900,
  dedicated_setup: 150000,
  dedicated_monthly: 150000,
  reviews_monthly: 4900,
  minutes_100: 2500,
};

async function stripePost(params) {
  if (!STRIPE_KEY) throw new Error("STRIPE_SECRET_KEY not configured");
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + STRIPE_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error("Stripe API error: " + txt.slice(0, 300));
  }
  return res.json();
}

function setLine(params, i, { name, amount, recurring }) {
  params.set(`line_items[${i}][price_data][currency]`, "usd");
  params.set(`line_items[${i}][price_data][product_data][name]`, name);
  params.set(`line_items[${i}][price_data][unit_amount]`, String(amount));
  if (recurring) {
    params.set(`line_items[${i}][price_data][recurring][interval]`, "month");
  }
  params.set(`line_items[${i}][quantity]`, "1");
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "bad_json" }) };
  }

  try {
    // ---- Minute reload pack ----
    if (body.sku === "minutes-100") {
      if (!body.business_id) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: "business_id required" }) };
      }
      const params = new URLSearchParams({
        "payment_method_types[0]": "card",
        mode: "payment",
        success_url: `${SITE}/customer.html?reloaded=1`,
        cancel_url: `${SITE}/customer.html?reload_cancelled=1`,
        "metadata[type]": "minutes_reload",
        "metadata[business_id]": String(body.business_id),
        "metadata[minutes]": "100",
      });
      setLine(params, 0, { name: "OpenLine: 100 extra minutes", amount: PRICES.minutes_100 });
      const s = await stripePost(params);
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, url: s.url }) };
    }

    // ---- Plan purchase ----
    const plan = body.plan;
    if (plan !== "shared" && plan !== "dedicated") {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "plan must be shared or dedicated" }) };
    }
    const addons = Array.isArray(body.addons) ? body.addons : [];
    const biz = body.business || {};
    if (!biz.name || !biz.email) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "business name and email required" }) };
    }

    const params = new URLSearchParams({
      "payment_method_types[0]": "card",
      mode: "subscription",
      customer_email: biz.email,
      success_url: `${SITE}/pricing.html?purchased=1`,
      cancel_url: `${SITE}/pricing.html?cancelled=1`,
      "metadata[type]": "openline_plan",
      "metadata[plan]": plan,
      "metadata[business_name]": String(biz.name).slice(0, 120),
      "metadata[contact_name]": String(biz.contact || "").slice(0, 120),
      "metadata[contact_email]": String(biz.email).slice(0, 120),
      "metadata[contact_phone]": String(biz.phone || "").slice(0, 40),
      "metadata[addons]": addons.join(","),
    });

    let i = 0;
    if (plan === "dedicated") {
      setLine(params, i++, { name: "OpenLine Dedicated: setup", amount: PRICES.dedicated_setup });
      setLine(params, i++, { name: "OpenLine Dedicated: monthly", amount: PRICES.dedicated_monthly, recurring: true });
    } else {
      setLine(params, i++, { name: "OpenLine Shared: monthly", amount: PRICES.shared_monthly, recurring: true });
    }
    if (addons.includes("reviews")) {
      setLine(params, i++, { name: "OpenLine: reviews add-on (monthly)", amount: PRICES.reviews_monthly, recurring: true });
    }

    const s = await stripePost(params);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, url: s.url }) };
  } catch (e) {
    console.error("openline-checkout failed:", e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "checkout_failed" }) };
  }
};
