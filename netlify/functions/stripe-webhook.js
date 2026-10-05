/* Stripe webhook: verifies $150 assessment payments server-side.
   Replaces the old ?paid=1 trust model. On checkout.session.completed with
   amount 15000 USD, records the payer's email in the payments table
   (via the service-role key). The assessment page then checks entitlement
   through verify-payment.js instead of trusting the URL.

   Env: STRIPE_WEBHOOK_SECRET (from the Stripe dashboard webhook endpoint),
        SUPABASE_URL, SUPABASE_SERVICE_KEY. */

"use strict";

var crypto = require("crypto");

var SUPABASE_URL = process.env.SUPABASE_URL || "";
var SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
var WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

function verifySignature(header, rawBody) {
  if (!header || !WEBHOOK_SECRET) return false;
  var parts = {};
  header.split(",").forEach(function (p) {
    var kv = p.split("=");
    if (kv.length === 2) parts[kv[0]] = kv[1];
  });
  var t = parseInt(parts.t, 10), v1 = parts.v1 || "";
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > 300) return false; // 5 min tolerance
  var signed = t + "." + rawBody;
  var expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(signed, "utf8").digest("hex");
  var a = Buffer.from(expected, "utf8"), b = Buffer.from(v1, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function recordPayment(row) {
  // Idempotent: stripe_session_id is unique; upsert on conflict.
  var res = await fetch(SUPABASE_URL + "/rest/v1/payments?on_conflict=stripe_session_id", {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify(row)
  });
  if (!res.ok) {
    var txt = await res.text().catch(function () { return ""; });
    throw new Error("supabase upsert failed: " + res.status + " " + txt.slice(0, 200));
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "method not allowed" };
  }
  var raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");
  var sig = event.headers["stripe-signature"] || event.headers["Stripe-Signature"];
  if (!verifySignature(sig, raw)) {
    return { statusCode: 400, body: "bad signature" };
  }
  var evt;
  try { evt = JSON.parse(raw); } catch (e) {
    return { statusCode: 400, body: "bad json" };
  }
  if (evt.type === "checkout.session.completed") {
    var s = evt.data && evt.data.object ? evt.data.object : {};
    var amount = s.amount_total, currency = (s.currency || "").toLowerCase();
    var email = (s.customer_details && s.customer_details.email) || s.customer_email || "";
    if (amount === 15000 && currency === "usd" && email && SERVICE_KEY && SUPABASE_URL) {
      try {
        await recordPayment({
          email: email.toLowerCase(),
          amount: amount,
          currency: currency,
          product: "assessment",
          stripe_session_id: s.id || null,
          stripe_customer_id: (typeof s.customer === "string" ? s.customer : null)
        });
      } catch (e) {
        console.error("recordPayment failed:", e.message);
        return { statusCode: 500, body: "record failed" };
      }
    }
  }
  return { statusCode: 200, body: "ok" };
};
