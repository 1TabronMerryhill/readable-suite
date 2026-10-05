/* verify-payment: does this email have a verified $150 assessment payment?
   Called by the assessment start page after Stripe redirects back with
   ?paid=1. Replaces trusting the URL or localStorage alone.

   POST { email } -> { paid: true/false }
   Reads the payments table with the service-role key (never exposed). */

"use strict";

var SUPABASE_URL = process.env.SUPABASE_URL || "";
var SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { "Content-Type": "application/json" }, body: "{}" };
  }
  var email = "";
  try { email = (JSON.parse(event.body || "{}").email || "").toLowerCase().trim(); } catch (e) {}
  if (!email || !SERVICE_KEY || !SUPABASE_URL) {
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paid: false }) };
  }
  try {
    var url = SUPABASE_URL + "/rest/v1/payments?select=id&email=eq." + encodeURIComponent(email) +
      "&product=eq.assessment&amount=eq.15000&limit=1";
    var res = await fetch(url, {
      headers: { "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY }
    });
    if (!res.ok) throw new Error("supabase read failed: " + res.status);
    var rows = await res.json();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paid: Array.isArray(rows) && rows.length > 0 })
    };
  } catch (e) {
    console.error("verify-payment failed:", e.message);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paid: false }) };
  }
};
