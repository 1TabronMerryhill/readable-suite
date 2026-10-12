/* Readable Station Gate 2 — Twilio SMS inbound webhook.
   POST /api/station/sms (rewritten to /.netlify/functions/sms-inbound)

   Verifies the Twilio signature, matches the Twilio number to a business,
   runs the channel-agnostic pipeline, and replies with TwiML.

   v1 behavior is intent-driven completion, not fixed sequences. The old
   LeadLeak timing (0.5min / 60min / 24h) is intentionally NOT ported:
   the agent answers the actual question or completes the actual order
   in this turn. Follow-ups, if needed, are Phase 2.

   Env (never committed):
     TWILIO_AUTH_TOKEN   — request signature verification
     TWILIO_NUMBER_MAP   — JSON: { "+15735551234": "business-slug" }
     STATION_PUBLIC_SMS_URL — full public URL Twilio calls (for signature);
                              defaults to https://daymarket.tabronmerryhill.com/api/station/sms
     SUPABASE_SERVICE_KEY, AGENT_API_KEY, STATION_BASE_URL — pipeline deps
*/

const lib = require("./station-lib");
const { runPipeline, defaultGetBusinessData } = require("./station-call");

function numberMap() {
  try {
    return JSON.parse(process.env.TWILIO_NUMBER_MAP || "{}");
  } catch {
    return {};
  }
}

function productionDeps(serviceKey) {
  const q = (m, p, b) => lib.sb(serviceKey, m, p, b);
  return {
    getBusinessData: (ref) => defaultGetBusinessData(serviceKey, ref),
    resolveBuyer: async (email) => {
      const r = await q("GET", "/dm_members?email=eq." + encodeURIComponent(email) + "&select=id,email");
      return r.status === 200 && r.data && r.data[0] ? r.data[0] : null;
    },
    invokeCateringGate: async (orderInput) => {
      const base = process.env.STATION_BASE_URL || "https://daymarket.tabronmerryhill.com";
      const r = await fetch(base + "/api/agent/order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agent-key": process.env.AGENT_API_KEY || "",
        },
        body: JSON.stringify(orderInput),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: !!data.ok, order: data.order, error: data.error };
    },
    queueReview: async (payload) => {
      const r = await q("POST", "/dm_station_reviews", payload);
      return r.status === 201 && r.data && r.data[0] ? r.data[0] : null;
    },
    writeVerification: async (rec) => {
      const r = await q("POST", "/dm_agent_verifications", {
        order_id: rec.order_id || null,
        endpoint: rec.endpoint,
        channel: rec.channel || "sms",
        event_type: rec.event_type || null,
        inputs_hash: rec.inputs_hash,
        status: rec.status || "processed",
        agent_ref: rec.agent_ref || null,
      });
      return r.status === 201 && r.data && r.data[0] ? r.data[0] : null;
    },
    findVerification: async (agentRef) => {
      const r = await q(
        "GET",
        "/dm_agent_verifications?agent_ref=eq." + encodeURIComponent(agentRef) + "&select=id,inputs_hash,event_type,status&order=created_at.desc&limit=1"
      );
      return r.status === 200 && r.data && r.data[0] ? r.data[0] : null;
    },
    now: () => Date.now(),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return lib.twiml(405, `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return lib.bad(503, "station_not_provisioned", "The operator must set TWILIO_AUTH_TOKEN.");
  }
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    return lib.bad(503, "station_not_provisioned", "The operator must set SUPABASE_SERVICE_KEY.");
  }

  const params = lib.parseTwilioBody(event);
  const signature = event.headers["x-twilio-signature"] || event.headers["X-Twilio-Signature"];
  const publicUrl = process.env.STATION_PUBLIC_SMS_URL || "https://daymarket.tabronmerryhill.com/api/station/sms";
  if (!lib.verifyTwilioSignature(authToken, publicUrl, params, signature)) {
    return lib.bad(401, "bad_signature", "Twilio signature verification failed.");
  }

  const from = lib.normalizePhone(params.From);
  const to = lib.normalizePhone(params.To);
  const body = String(params.Body || "").trim();
  const sid = String(params.MessageSid || "");
  if (!from || !to) return lib.twiml(200, `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);

  const map = numberMap();
  const businessRef = map[to] || map[String(params.To)] || null;
  if (!businessRef) {
    /* Unknown Twilio number: stay silent rather than reply from the wrong business. */
    return lib.twiml(200, `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }

  const deps = productionDeps(serviceKey);
  let result;
  try {
    result = await runPipeline(
      {
        business_ref: businessRef,
        caller_phone: from,
        text: body,
        channel: "sms",
        idempotency_key: sid ? "sms:" + sid : undefined,
      },
      deps
    );
  } catch (err) {
    /* Never leave the caller in silence: truthful fallback. */
    return lib.twiml(200, lib.smsReply("Sorry, something went wrong on our end. Someone from the shop will text you shortly."));
  }

  const reply = (result && result.reply) || "Thanks for texting us. Someone will be with you shortly.";
  return lib.twiml(200, lib.smsReply(reply));
};

/* Exported for tests. */
exports.productionDeps = productionDeps;
exports.numberMap = numberMap;
