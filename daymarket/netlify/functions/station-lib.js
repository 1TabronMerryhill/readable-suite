/* Readable Station — shared library for Gate 2 (Phone Gate).
   Pure helpers + Supabase REST + Twilio webhook utilities.
   No secrets committed: everything sensitive comes from env vars. */

const crypto = require("crypto");
const querystring = require("querystring");

const SUPABASE_URL = "https://evmynxxvyafvnreaudpr.supabase.co";
const REST = SUPABASE_URL + "/rest/v1";

/* ---------- HTTP responses (Netlify Function shape) ---------- */
function json(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}
const bad = (status, code, message, extra) =>
  json(status, Object.assign({ ok: false, error: code, message }, extra || {}));

function twiml(status, xml) {
  return {
    statusCode: status || 200,
    headers: { "Content-Type": "text/xml" },
    body: xml,
  };
}

/* ---------- hashing / canonicalization (matches agent-order.js) ---------- */
function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v);
}

/* ---------- Supabase REST ---------- */
function sb(serviceKey, method, path, body) {
  return fetch(REST + path, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: "Bearer " + serviceKey,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => {
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: r.status, data };
  });
}

/* ---------- phone ---------- */
const E164_RE = /^\+1\d{10}$/;
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "1") return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return null;
}

/* ---------- Twilio request signature verification ----------
   Twilio signs: full public URL + POST params sorted by name, values
   concatenated, HMAC-SHA1 with the auth token, base64-encoded.
   Compare against the X-Twilio-Signature header. */
function verifyTwilioSignature(authToken, publicUrl, params, signature) {
  if (!authToken || !signature) return false;
  const names = Object.keys(params).sort();
  let data = publicUrl;
  for (const n of names) data += n + params[n];
  const expected = crypto.createHmac("sha1", authToken).update(data, "utf8").digest("base64");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseTwilioBody(event) {
  const ct = (event.headers["content-type"] || event.headers["Content-Type"] || "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded")) {
    return querystring.parse(event.body || "");
  }
  try {
    return JSON.parse(event.body || "{}");
  } catch {
    return {};
  }
}

/* ---------- TwiML builders ---------- */
function escXml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function smsReply(text) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escXml(text)}</Message></Response>`;
}
function voiceGreetingThenSms({ sayText, smsFrom, smsTo, smsText }) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Say voice="alice">${escXml(sayText)}</Say>` +
    `<Sms from="${escXml(smsFrom)}" to="${escXml(smsTo)}">${escXml(smsText)}</Sms>` +
    `<Hangup/></Response>`
  );
}

/* Resolve a Twilio number to a business slug.
   Primary source is the phone_number column on dm_businesses;
   TWILIO_NUMBER_MAP env var remains as a fallback. */
async function resolveBusinessRefByNumber(serviceKey, number) {
  const e164 = normalizePhone(number);
  if (e164) {
    try {
      const r = await sb(
        serviceKey,
        "GET",
        "/dm_businesses?phone_number=eq." + encodeURIComponent(e164) + "&select=slug&limit=1"
      );
      if (r.status === 200 && r.data && r.data[0] && r.data[0].slug) {
        return r.data[0].slug;
      }
    } catch { /* fall through to env map */ }
  }
  try {
    const map = JSON.parse(process.env.TWILIO_NUMBER_MAP || "{}");
    return map[number] || map[e164] || null;
  } catch {
    return null;
  }
}

module.exports = {
  json,
  bad,
  twiml,
  sha256,
  canonical,
  sb,
  E164_RE,
  normalizePhone,
  resolveBusinessRefByNumber,
  verifyTwilioSignature,
  parseTwilioBody,
  escXml,
  smsReply,
  voiceGreetingThenSms,
  SUPABASE_URL,
};
