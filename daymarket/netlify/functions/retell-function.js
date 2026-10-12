/* Readable Station Gate 2 — Retell custom function endpoint.
   POST /api/station/retell (rewritten to /.netlify/functions/retell-function)

   Retell calls this URL as a custom function ("station_turn") during a live
   voice call. The agent passes the caller's utterance; we run the exact same
   channel-agnostic pipeline as SMS (classify -> extract -> validate ->
   decide -> truthful reply) and return the reply for the agent to speak.

   This is what makes the voice gate deterministic: the LLM talks, the
   pipeline decides. The agent NEVER invents order state, prices, or hours —
   every word it speaks about the business comes from the pipeline reply.

   Retell request shape (custom function webhook):
     { call: { call_id, from_number, to_number }, args: { text } }

   Response shape (Retell speaks `reply`):
     { ok: true, decision, reply, confidence }

   Env (never committed):
     RETELL_FUNCTION_SECRET — shared secret; must match x-retell-secret header
     TWILIO_NUMBER_MAP      — JSON: { "+15738282028": "business-slug" }
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
        channel: rec.channel || "voice",
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
    return lib.bad(405, "method_not_allowed", "POST only.");
  }

  const secret = process.env.RETELL_FUNCTION_SECRET;
  const provided = event.headers["x-retell-secret"] || event.headers["X-Retell-Secret"];
  if (!secret || provided !== secret) {
    return lib.bad(401, "bad_secret", "Invalid function secret.");
  }
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    return lib.bad(503, "station_not_provisioned", "The operator must set SUPABASE_SERVICE_KEY.");
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return lib.bad(400, "bad_json", "Request body must be JSON.");
  }

  const call = body.call || {};
  const args = body.args || {};
  const text = String(args.text || "").trim();
  if (!text) {
    return lib.json(200, { ok: true, decision: "clarify", reply: "Sorry, I didn't catch that. What would you like?", confidence: 0 });
  }

  const from = lib.normalizePhone(call.from_number);
  const to = lib.normalizePhone(call.to_number);
  const callId = String(call.call_id || "");
  const map = numberMap();
  const businessRef = (to && map[to]) || null;
  if (!businessRef) {
    /* Unknown number: never speak for the wrong business. */
    return lib.json(200, {
      ok: true,
      decision: "escalate",
      reply: "I'm sorry, I'm not able to take this call right now.",
      confidence: 0,
    });
  }

  const deps = productionDeps(serviceKey);
  let result;
  try {
    result = await runPipeline(
      {
        business_ref: businessRef,
        caller_phone: from,
        text,
        channel: "voice",
        idempotency_key: callId ? "retell:" + callId + ":" + lib.sha256(text).slice(0, 12) : undefined,
      },
      deps
    );
  } catch (err) {
    return lib.json(200, {
      ok: true,
      decision: "escalate",
      reply: "Sorry, something went wrong on our end. Someone from the shop will call you back shortly.",
      confidence: 0,
    });
  }

  return lib.json(200, {
    ok: !!result.ok,
    decision: result.decision || "escalate",
    reply: result.reply || "Thanks for calling. Someone will be with you shortly.",
    confidence: result.confidence != null ? result.confidence : 0,
    order_id: result.order && result.order.id ? result.order.id : null,
  });
};

exports.productionDeps = productionDeps;
exports.numberMap = numberMap;
