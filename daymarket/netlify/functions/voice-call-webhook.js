/* DayMarket Voice: Retell call webhook -> dm_voice_calls + billing rollup.
 *
 * Retell POSTs agent-level webhook events here. We handle `call_ended`
 * (which carries the full call object: transcript, duration, cost) and write
 * one row per call into dm_voice_calls, then roll minutes into the business's
 * open billing cycle (lazy-created per calendar month).
 *
 * Contract (matches dashboard voice-data.js):
 *   dm_voice_calls: retell_call_id unique, outcome in
 *     (order_placed, question, callback, missed)
 *   dm_voice_billing_cycles: minutes_used / overage_minutes rolled up here.
 *     Money math (base, rates) lives in the dashboard config; this webhook
 *     only tracks minutes and ensures the cycle exists.
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://evmynxxvyafvnreaudpr.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REST = SUPABASE_URL + "/rest/v1";

// v1: agent_id -> business slug. Extend as dedicated agents onboard.
const AGENT_BUSINESS = {
  agent_81e290a0ec6765ca3b54e0d3e0: "elliannas-donut-shop",
};

const json = (status, obj) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

async function sbGet(table, query) {
  const res = await fetch(`${REST}/${table}?${query}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`sbGet ${table} ${res.status}`);
  return res.json();
}

async function sbPost(table, row) {
  const res = await fetch(`${REST}/${table}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`sbPost ${table} ${res.status}`);
  const rows = await res.json();
  return rows[0];
}

async function sbPatch(table, id, patch) {
  const res = await fetch(`${REST}/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`sbPatch ${table} ${res.status}`);
  const rows = await res.json();
  return rows[0];
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "1") return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return null;
}

async function resolveBusinessId(slug) {
  const rows = await sbGet(
    "dm_businesses",
    `select=id,station_data&slug=eq.${encodeURIComponent(slug)}&limit=1`
  );
  if (!rows.length) return null;
  return rows[0];
}

function monthBounds(d) {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  const fmt = (x) => x.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

async function ensureOpenCycle(business) {
  const now = new Date();
  const { start, end } = monthBounds(now);
  const existing = await sbGet(
    "dm_voice_billing_cycles",
    `select=id,status&business_id=eq.${business.id}` +
      `&cycle_start=eq.${start}&limit=1`
  );
  if (existing.length) return existing[0];
  // Close any older open cycles for this business.
  const open = await sbGet(
    "dm_voice_billing_cycles",
    `select=id&business_id=eq.${business.id}&status=eq.open&cycle_start=lt.${start}`
  );
  for (const c of open) {
    try {
      await sbPatch("dm_voice_billing_cycles", c.id, { status: "closed" });
    } catch (e) {
      console.error("cycle close failed:", e.message);
    }
  }
  const plan =
    (business.station_data && business.station_data.voice_plan) || "shared";
  return sbPost("dm_voice_billing_cycles", {
    business_id: business.id,
    cycle_start: start,
    cycle_end: end,
    plan: plan === "dedicated" ? "dedicated" : "shared",
    status: "open",
  });
}

async function classifyOutcome(call, businessId, callerPhone, startTs, endTs) {
  const durationS = Math.round(
    ((endTs || Date.now()) - (startTs || Date.now())) / 1000
  );
  if (durationS < 10) return { outcome: "missed", orderId: null };
  // Did this call produce an order? Match caller + time window.
  try {
    if (callerPhone) {
      const winStart = new Date(startTs - 5 * 60 * 1000).toISOString();
      const winEnd = new Date(endTs + 15 * 60 * 1000).toISOString();
      const orders = await sbGet(
        "dm_orders",
        `select=id,total_cents&business_id=eq.${businessId}` +
          `&caller_phone=eq.${encodeURIComponent(callerPhone)}` +
          `&channel=eq.voice&created_at=gte.${encodeURIComponent(winStart)}` +
          `&created_at=lte.${encodeURIComponent(winEnd)}` +
          `&order=created_at.desc&limit=1`
      );
      if (orders.length)
        return { outcome: "order_placed", orderId: orders[0].id };
    }
  } catch (e) {
    console.error("order match failed:", e.message);
  }
  const t = (call.transcript || "").toLowerCase();
  if (/call (you|them|me) back|have (them|the shop) call/.test(t))
    return { outcome: "callback", orderId: null };
  return { outcome: "question", orderId: null };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false });
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { ok: false, error: "bad_json" });
  }

  // We only care about call_ended; ack everything else quietly.
  if (body.event !== "call_ended") return json(200, { ok: true, ignored: body.event });
  const call = body.call || {};
  const callId = call.call_id;
  const agentId = call.agent_id;
  if (!callId || !agentId) return json(400, { ok: false, error: "missing_call" });

  const slug = AGENT_BUSINESS[agentId];
  if (!slug) {
    console.error("voice webhook: unknown agent", agentId);
    return json(200, { ok: true, ignored: "unknown_agent" });
  }

  try {
    const business = await resolveBusinessId(slug);
    if (!business) {
      console.error("voice webhook: unknown business slug", slug);
      return json(200, { ok: true, ignored: "unknown_business" });
    }

    const startTs = call.start_timestamp || Date.now();
    const endTs = call.end_timestamp || Date.now();
    const durationS = Math.max(
      0,
      Math.round((endTs - startTs) / 1000)
    );
    const callerPhone = normalizePhone(call.from_number);
    const { outcome, orderId } = await classifyOutcome(
      call,
      business.id,
      callerPhone,
      startTs,
      endTs
    );

    // Cost: Retell's call_cost if present, else duration-based fallback.
    let costCents = null;
    const rc = call.call_cost || {};
    if (rc.combined_cost != null) costCents = Math.round(rc.combined_cost * 100);

    // Idempotent upsert on retell_call_id.
    const existing = await sbGet(
      "dm_voice_calls",
      `select=id&retell_call_id=eq.${encodeURIComponent(callId)}&limit=1`
    );
    const row = {
      business_id: business.id,
      retell_call_id: callId,
      agent_id: agentId,
      caller_phone: callerPhone,
      started_at: new Date(startTs).toISOString(),
      duration_seconds: durationS,
      outcome,
      order_id: orderId,
      transcript_text: (call.transcript || "").slice(0, 20000),
      cost_cents: costCents,
    };
    let saved;
    if (existing.length) {
      saved = await sbPatch("dm_voice_calls", existing[0].id, row);
    } else {
      saved = await sbPost("dm_voice_calls", row);
    }

    // Roll minutes into the open billing cycle.
    const cycle = await ensureOpenCycle(business);
    const minutes = durationS / 60;
    const newUsed = parseFloat(cycle.minutes_used || 0) + minutes;
    const included = parseFloat(cycle.included_minutes || 0);
    const overage = Math.max(0, newUsed - included);
    await sbPatch("dm_voice_billing_cycles", cycle.id, {
      minutes_used: Math.round(newUsed * 100) / 100,
      overage_minutes: Math.round(overage * 100) / 100,
    });

    console.log(
      "voice call logged",
      callId,
      outcome,
      durationS + "s",
      business.id
    );
    return json(200, { ok: true, call_row: saved.id, outcome });
  } catch (e) {
    console.error("voice webhook failed:", e.message);
    return json(500, { ok: false, error: "action_failed" });
  }
};
