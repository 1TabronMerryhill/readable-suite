/* Readable Station Gate 2 — Twilio voice webhook (v1 stub).
   POST /api/station/voice (rewritten to /.netlify/functions/voice-webhook)

   v1 answers the call with TwiML: a greeting, then hands the caller to SMS
   completion ("we'll text you right now to take your order"). The reply to
   that text runs the full pipeline via sms-inbound.

   PHASE 3 SEAM: if VOICE_AGENT_URL is set, the call is <Redirect>ed to the
   realtime voice platform instead of the stub. The platform takes over the
   conversation; this stub stays as the fallback when the platform is
   unreachable. Set VOICE_AGENT_URL to enable; unset to keep the stub.

   Env (never committed):
     TWILIO_AUTH_TOKEN   — request signature verification
     TWILIO_NUMBER_MAP   — JSON: { "+15735551234": "business-slug" }
     STATION_PUBLIC_VOICE_URL — full public URL Twilio calls (for signature);
                                defaults to https://daymarket.tabronmerryhill.com/api/station/voice
     VOICE_AGENT_URL     — Phase 3: realtime platform webhook URL (optional)
     SUPABASE_SERVICE_KEY — call-event logging (optional in v1; events are
                            best-effort and never block the TwiML response)
*/

const lib = require("./station-lib");

function numberMap() {
  try {
    return JSON.parse(process.env.TWILIO_NUMBER_MAP || "{}");
  } catch {
    return {};
  }
}

async function logCallEvent(serviceKey, fields) {
  if (!serviceKey) return null;
  try {
    const r = await lib.sb(serviceKey, "POST", "/dm_agent_verifications", {
      order_id: null,
      endpoint: "/api/station/voice",
      channel: "voice",
      event_type: fields.event_type,
      inputs_hash: lib.sha256(lib.canonical({ from: fields.from, to: fields.to, sid: fields.sid })),
      status: "processed",
      agent_ref: fields.sid ? "voice:" + fields.sid : null,
    });
    return r.status === 201 && r.data && r.data[0] ? r.data[0] : null;
  } catch {
    return null; /* logging never blocks the call */
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return lib.twiml(405, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return lib.bad(503, "station_not_provisioned", "The operator must set TWILIO_AUTH_TOKEN.");
  }

  const params = lib.parseTwilioBody(event);
  const signature = event.headers["x-twilio-signature"] || event.headers["X-Twilio-Signature"];
  const publicUrl = process.env.STATION_PUBLIC_VOICE_URL || "https://daymarket.tabronmerryhill.com/api/station/voice";
  if (!lib.verifyTwilioSignature(authToken, publicUrl, params, signature)) {
    return lib.bad(401, "bad_signature", "Twilio signature verification failed.");
  }

  const from = lib.normalizePhone(params.From);
  const to = lib.normalizePhone(params.To);
  const sid = String(params.CallSid || "");
  const map = numberMap();
  const businessRef = (to && (map[to] || map[String(params.To)])) || null;

  /* Best-effort event log; never blocks the TwiML. */
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || null;
  const logPromise = logCallEvent(serviceKey, {
    event_type: "call_answered",
    from,
    to,
    sid,
  });

  /* Phase 3 seam: hand the live call to the realtime voice platform. */
  const voiceAgentUrl = process.env.VOICE_AGENT_URL;
  if (voiceAgentUrl) {
    await logPromise;
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      `<Redirect method="POST">${lib.escXml(voiceAgentUrl)}</Redirect>` +
      `</Response>`;
    return lib.twiml(200, xml);
  }

  /* v1 stub: greeting + SMS handoff, then hangup. */
  const businessName = businessRef ? businessRef.replace(/-/g, " ") : "the shop";
  const sayText = `Thanks for calling. We can't pick up right now, but we'll text you in the next minute to take your order.`;
  const smsText = `Hi, sorry we missed your call! Reply here and I'll take your order right now.`;
  const xml = lib.voiceGreetingThenSms({
    sayText,
    smsFrom: to || "",
    smsTo: from || "",
    smsText,
  });
  await logPromise;
  /* Note: businessName is available for a friendlier greeting once the
     business display name is fetched; v1 keeps the greeting generic so a
     misconfigured number map can never misidentify the business on a call. */
  void businessName;
  return lib.twiml(200, xml);
};

exports.numberMap = numberMap;
exports.logCallEvent = logCallEvent;
