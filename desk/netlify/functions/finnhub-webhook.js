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
     BUS_URL, BUS_TOKEN — the Railway feed pipeline service. When both are
     set, a verified event is POSTed to BUS_URL/ingest with the Bearer
     token, after the 200 ack. When unset, the receiver keeps the log-only
     behavior below.

   Endpoint: https://opone.tabronmerryhill.com/api/finnhub-webhook
   (200 rewrite in desk/netlify.toml to /.netlify/functions/finnhub-webhook).

   v1 scope: verify the secret, ack 200, log the event to the function logs
   (Netlify dashboard), then forward it to the bus when configured. The
   forward is bounded (2s) and never fails the ack: a bus error is logged,
   the ack still goes out. The bus validates the event against the Desk
   contract, so a raw Finnhub event that does not match the contract is
   rejected there; once the Test Webhook button reveals the real payload
   shape, map it to a contract event here. The exact Finnhub event catalog
   was not verifiable from public docs; the receiver is payload-agnostic
   and logs whatever JSON arrives, so the Test Webhook button reveals the
   shape live. */

"use strict";

var crypto = require("crypto");

var WEBHOOK_SECRET = process.env.FINNHUB_WEBHOOK_SECRET || "";
var BUS_URL = (process.env.BUS_URL || "").replace(/\/$/, "");
var BUS_TOKEN = process.env.BUS_TOKEN || "";

function secretsEqual(a, b) {
  if (!a || !b) return false;
  var ba = Buffer.from(a, "utf8"), bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Wrap a verified Finnhub event into a Desk contract event before the
// forward. The bus only accepts the 12 contract types with ts as a
// string, and a raw Finnhub body matches neither, so an unwrapped
// forward is rejected there. Until the Test Webhook button reveals the
// real payload shape, every raw event goes in as news.event with the
// whole body in payload; an event that already matches the contract
// passes through unchanged. Once the shape is known, map trade-shaped
// events to quote.tick here.
function toContractEvent(evt) {
  if (evt && typeof evt.type === "string" && typeof evt.ts === "string"
      && typeof evt.id === "string" && evt.payload) {
    return evt;
  }
  return {
    type: "news.event",
    id: "finnhub-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    ts: new Date().toISOString(),
    source: "finnhub",
    feed: "finnhub",
    payload: evt,
  };
}

// Forward a verified event to the Railway bus /ingest. Fire and forget
// with a 2s cap: the ack is already decided, a bus error is logged and
// never fails it. The response is sent when this handler returns, so the
// forward runs before the return but cannot hold it up.
async function forwardToBus(evt) {
  if (!BUS_URL || !BUS_TOKEN) return;
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 2000);
  try {
    var res = await fetch(BUS_URL + "/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + BUS_TOKEN,
      },
      body: JSON.stringify(toContractEvent(evt)),
      signal: ctrl.signal,
    });
    console.log("finnhub-webhook forward: bus=" + res.status);
  } catch (e) {
    console.log("finnhub-webhook forward failed: " + e.message);
  } finally {
    clearTimeout(timer);
  }
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
  // Forward to the bus when configured. Bounded and safe: it cannot fail
  // the ack, and a bus error is only logged.
  if (evt) {
    await forwardToBus(evt);
  }
  return ack;
};
