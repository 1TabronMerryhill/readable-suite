/* Finnhub outbound webhook receiver (OpOne Capital intelligence desk).
   Finnhub's server POSTs events to the URL configured on the Finnhub
   dashboard (Webhook settings). Every request carries the header
   "X-Finnhub-Secret" with the secret shown on that page.

   This is the OTHER Finnhub push path, distinct from the websocket:
   - websocket (finnhub_ws.py): WE connect to Finnhub and subscribe.
   - dashboard webhook (this function): FINNHUB connects to US and POSTs.
   Both feed the Desk's event bus. The dashboard webhook is the one that
   needs a public URL; the websocket needs only a valid API key.

   Behavior, in Finnhub's own order: acknowledge FIRST with a 2xx, then do
   the work. The endpoint is disabled if it fails to acknowledge events over
   consecutive days, so the 200 goes out before any logic runs.

   Env (set in the Netlify dashboard, never committed):
     FINNHUB_WEBHOOK_SECRET — the secret shown on the Finnhub dashboard
     Webhook page. The value is never written to a file, a log, or chat.

   Endpoint (after deploy): https://readable.tabronmerryhill.com/api/finnhub-webhook
   (200 rewrite in netlify.toml to /.netlify/functions/finnhub-webhook).

   v1 scope: verify the secret, ack 200, log the event to the function logs
   (Netlify dashboard). No event store yet: the Desk's event bus (Phase 3)
   will consume these. The exact Finnhub event catalog was not verifiable
   from public docs; the receiver is payload-agnostic and logs whatever
   JSON arrives, so the Test Webhook button reveals the shape live. */

"use strict";

var crypto = require("crypto");

var WEBHOOK_SECRET = process.env.FINNHUB_WEBHOOK_SECRET || "";

function secretsEqual(a, b) {
  if (!a || !b) return false;
  var ba = Buffer.from(a, "utf8"), bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

exports.handler = async function (event) {
  if (event.httpMethod === "GET") {
    return { statusCode: 200, body: "finnhub-webhook ok" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "method not allowed" };
  }
  if (!WEBHOOK_SECRET) {
    console.error("finnhub-webhook: FINNHUB_WEBHOOK_SECRET not configured");
    return { statusCode: 500, body: "not_configured" };
  }
  var headers = event.headers || {};
  var secret = headers["x-finnhub-secret"] || headers["X-Finnhub-Secret"];
  if (!secretsEqual(secret, WEBHOOK_SECRET)) {
    return { statusCode: 401, body: "bad secret" };
  }
  var raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");
  var evt = null;
  try { evt = JSON.parse(raw); } catch (e) { evt = null; }
  // Acknowledge first, per Finnhub: 2xx before any logic.
  var ack = { statusCode: 200, body: "ok" };
  // v1 logging only: type plus keys, never the secret, never the raw body
  // beyond what the function logs already hold.
  try {
    var kind = evt && evt.type ? evt.type : "unknown";
    var keys = evt ? Object.keys(evt).join(",") : "";
    console.log("finnhub-webhook event: type=" + kind + " keys=" + keys);
  } catch (e) {
    console.log("finnhub-webhook event: unlogged (" + e.message + ")");
  }
  return ack;
};
