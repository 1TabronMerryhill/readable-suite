// drawings.js — the Desk shared drawing editor proxy.
// GET    /api/drawings?symbol=X        -> that symbol's shared drawings
// POST   /api/drawings                 -> upsert one / replace list / clear
// DELETE /api/drawings?symbol=X&id=Y   -> remove one drawing
//
// The drawings live on the Railway event bus (GET/POST/DELETE /drawings),
// persisted to drawings.json on the service volume. The bus requires the
// BUS_TOKEN Bearer; the token stays server side in this function and is
// never sent to the browser. The page and Bobby's drawings.py both talk
// to this endpoint, so Milly's lines and Bobby's lines land in one store.
//
// Required env vars (set in the Netlify dashboard, never committed):
//   BUS_URL, BUS_TOKEN — the Railway feed pipeline service.

const BUS_URL = (process.env.BUS_URL || "").replace(/\/$/, "");
const BUS_TOKEN = process.env.BUS_TOKEN || "";

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (!BUS_URL || !BUS_TOKEN) {
    return { statusCode: 502, headers,
      body: JSON.stringify({ error: "bus_not_configured" }) };
  }
  const method = (event.httpMethod || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST" && method !== "DELETE") {
    return { statusCode: 405, headers,
      body: JSON.stringify({ error: "method_not_allowed" }) };
  }
  const qs = event.rawQuery || "";
  const url = BUS_URL + "/drawings" + (qs ? "?" + qs : "");
  const init = {
    method,
    headers: { Authorization: "Bearer " + BUS_TOKEN },
  };
  if (method === "POST") {
    init.headers["Content-Type"] = "application/json";
    init.body = event.body || "";
    if (event.isBase64Encoded && event.body) {
      init.body = Buffer.from(event.body, "base64").toString("utf8");
    }
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    return { statusCode: 502, headers,
      body: JSON.stringify({ error: "bus_unreachable", detail: String((e && e.message) || e) }) };
  }
  const text = await res.text();
  return { statusCode: res.status, headers, body: text || "{}" };
};
