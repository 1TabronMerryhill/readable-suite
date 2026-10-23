/* DayMarket AI sales agent v2: a conversation, ported from the VictoryLap
   coach chat (threads, deterministic-first routing, proposal buttons that
   apply only on tap, audit log, grounded fallback, short replies).

   POST /.netlify/functions/ai-chat (redirect: /api/daymarket/ai-chat)
   Body: { business_id, thread_id?, message }

   The manager chats. Recognized requests are answered deterministically
   from real data, no model involved. Everything else goes to Groq with
   ONLY this business's own data (past holidays, offers, claims, packages,
   orders) plus the manager's words. The model may only propose; nothing is
   created, changed, or published here. The manager reviews a proposal and
   taps a button to apply it; the operator still approves before anything
   goes live. When the model fails, the reply falls back to real data and
   says so. Every invocation is audited.

   Env vars (Netlify dashboard, never committed):
     GROQ_API_KEY        — shared with the station functions
     SUPABASE_SERVICE_KEY — service-role key for Supabase REST reads/writes
     SUPABASE_URL        — optional; falls back to the known project URL
*/

"use strict";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "openai/gpt-oss-120b";
const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://evmynxxvyafvnreaudpr.supabase.co";

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function rest(path, serviceKey, method, payload) {
  const opts = {
    method: method || "GET",
    headers: {
      apikey: serviceKey,
      Authorization: "Bearer " + serviceKey,
      Accept: "application/json",
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
  };
  if (payload !== undefined) opts.body = JSON.stringify(payload);
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, opts);
  if (!res.ok) throw new Error("Supabase request failed: " + res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function toInt(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function money(cents) {
  if (cents === null || cents === undefined) return null;
  return "$" + (cents / 100).toFixed(2);
}

function proposalId() {
  try {
    return "p_" + require("crypto").randomUUID().slice(0, 8);
  } catch {
    return "p_" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }
}

/* Validate + clamp a model proposal. Same rules as the v1 agent, extended
   with an optional edit proposal (change one draft offer's price or cap). */
function cleanProposal(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type === "edit") {
    const target = typeof raw.target_offer_title === "string" ? raw.target_offer_title.trim() : "";
    if (!target) return null;
    const changes = {};
    const member = toInt(raw.member_price_cents);
    const regular = toInt(raw.regular_price_cents);
    const qty = toInt(raw.quantity_total);
    if (member !== null) changes.member_price_cents = member;
    if (regular !== null) changes.regular_price_cents = regular;
    if (qty !== null && qty > 0) changes.quantity_total = qty;
    if (!Object.keys(changes).length) return null;
    if (changes.member_price_cents !== undefined && changes.regular_price_cents !== undefined
      && changes.member_price_cents > changes.regular_price_cents) {
      changes.member_price_cents = changes.regular_price_cents;
    }
    return {
      id: proposalId(),
      type: "edit",
      label: raw.label && typeof raw.label === "string" ? raw.label : "Apply this change",
      target_offer_title: target,
      changes,
    };
  }
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  const startsAt =
    typeof raw.starts_at === "string" && !isNaN(Date.parse(raw.starts_at)) ? raw.starts_at : null;
  const endsAt =
    typeof raw.ends_at === "string" && !isNaN(Date.parse(raw.ends_at)) ? raw.ends_at : null;
  const offers = [];
  if (Array.isArray(raw.offers)) {
    for (const o of raw.offers.slice(0, 3)) {
      if (!o || typeof o.title !== "string" || !o.title.trim()) continue;
      let regular = toInt(o.regular_price_cents);
      let member = toInt(o.member_price_cents);
      if (member !== null && regular !== null && member > regular) member = regular;
      const qty = toInt(o.quantity_total);
      offers.push({
        title: o.title.trim(),
        details: typeof o.details === "string" ? o.details.trim() : "",
        regular_price_cents: regular,
        member_price_cents: member,
        quantity_total: qty !== null && qty > 0 ? qty : null,
      });
    }
  }
  return {
    id: proposalId(),
    type: "holiday",
    label: "Use this holiday",
    holiday: {
      title,
      description: typeof raw.description === "string" ? raw.description.trim() : "",
      starts_at: startsAt,
      ends_at: endsAt,
    },
    offers,
  };
}

async function logAudit(serviceKey, businessId, actor, action, details, result) {
  try {
    await rest("dm_agent_audit", serviceKey, "POST", {
      business_id: businessId,
      actor,
      action,
      details: details || {},
      result: result || "success",
    });
  } catch (e) {
    console.error("Agent audit write failed:", e.message);
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "POST only." });
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!serviceKey) return json(500, { error: "Server is not configured." });

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Bad request." });
    }
    const businessId = typeof body.business_id === "string" ? body.business_id : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!businessId || !message) return json(400, { error: "Missing business or message." });

    const auth = event.headers.authorization || event.headers.Authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { error: "Sign in first." });
    const whoRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: serviceKey, Authorization: "Bearer " + token },
    });
    if (!whoRes.ok) return json(401, { error: "Sign in first." });
    const who = await whoRes.json();

    const bizRows = await rest(
      "dm_businesses?id=eq." + encodeURIComponent(businessId) +
        "&select=id,owner_id,name,tagline,description,station_data",
      serviceKey
    );
    const biz = bizRows[0];
    if (!biz || biz.owner_id !== who.id) {
      await logAudit(serviceKey, businessId, "manager", "ai_chat.invoked",
        { reason: "not owner" }, "denied");
      return json(403, { error: "That business is not yours." });
    }

    // Thread: verify the given one, or start a new member thread.
    let threadId = typeof body.thread_id === "string" ? body.thread_id : "";
    if (threadId) {
      const t = await rest(
        "dm_agent_threads?id=eq." + encodeURIComponent(threadId) +
          "&business_id=eq." + encodeURIComponent(businessId) + "&select=id",
        serviceKey
      );
      if (!t[0]) return json(403, { error: "That conversation is not yours." });
    } else {
      const created = await rest("dm_agent_threads", serviceKey, "POST", {
        business_id: businessId,
        title: message.slice(0, 40) || "Conversation",
        origin: "member",
        context: {},
      });
      threadId = created[0].id;
    }

    await rest("dm_agent_messages", serviceKey, "POST", {
      thread_id: threadId,
      role: "member",
      content: message,
      intent: null,
      proposal: null,
    });
    await rest(
      "dm_agent_threads?id=eq." + encodeURIComponent(threadId),
      serviceKey, "PATCH", { updated_at: new Date().toISOString() }
    );

    const finish = async (reply, proposal, intent, source, dataUsed) => {
      await rest("dm_agent_messages", serviceKey, "POST", {
        thread_id: threadId,
        role: "agent",
        content: reply,
        intent: intent || null,
        proposal: proposal || null,
      });
      await logAudit(serviceKey, businessId, "agent", "ai_chat.invoked",
        { thread_id: threadId, intent: intent || source, message_preview: message.slice(0, 100) },
        "success");
      return json(200, { thread_id: threadId, reply, proposal: proposal || null, source, data_used: dataUsed || {} });
    };

    // ---------- Deterministic handlers (no model) ----------
    const lower = message.toLowerCase();
    const enc = encodeURIComponent(businessId);

    if (/repeat|run (it|that) again|same as last|do that again/.test(lower)) {
      const last = await rest(
        "dm_holidays?business_id=eq." + enc +
          "&select=id,title,description,starts_at,ends_at,status,dm_offers(title,details,regular_price_cents,member_price_cents,quantity_total,status)" +
          "&status=in.(published,ended)&order=starts_at.desc&limit=1",
        serviceKey
      ).catch(() => []);
      const h = last[0];
      if (h) {
        const proposal = {
          id: proposalId(),
          type: "holiday",
          label: "Repeat this holiday",
          holiday: { title: h.title, description: h.description || "", starts_at: null, ends_at: null },
          offers: (h.dm_offers || []).map((o) => ({
            title: o.title, details: o.details || "",
            regular_price_cents: o.regular_price_cents, member_price_cents: o.member_price_cents,
            quantity_total: o.quantity_total,
          })),
        };
        return finish(
          "Here is your last holiday, ready to run again. Check the details, pick a new window, then use it.",
          proposal, "repeat_last", "deterministic", { holidays: 1 }
        );
      }
      return finish("You have no past holiday to repeat yet. Tell me what is slow or extra and I will build one.",
        null, "repeat_last", "deterministic", {});
    }

    if (/what'?s live|currently live|running now|active holiday|live now/.test(lower)) {
      const live = await rest(
        "dm_holidays?business_id=eq." + enc + "&status=eq.published" +
          "&select=title,starts_at,ends_at,dm_offers(title,member_price_cents,quantity_total,quantity_claimed,status)" +
          "&order=starts_at.asc",
        serviceKey
      ).catch(() => []);
      if (!live.length) {
        return finish("Nothing is live right now. Your last holiday is the fastest thing to repeat, or tell me what is slow and I will build a new one.",
          null, "whats_live", "deterministic", {});
      }
      const lines = live.map((h) => {
        const offers = (h.dm_offers || []).filter((o) => o.status === "active")
          .map((o) => `${o.title} (${o.quantity_claimed || 0} claimed)`);
        return `${h.title}` + (offers.length ? `: ${offers.join(", ")}` : "");
      });
      return finish("Live right now:\n" + lines.join("\n"), null, "whats_live", "deterministic", { holidays: live.length });
    }

    if (/slow day|slowest|dead day/.test(lower)) {
      const orders = await rest(
        "dm_orders?business_id=eq." + enc + "&select=scheduled_for&order=scheduled_for.desc&limit=200",
        serviceKey
      ).catch(() => []);
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const counts = [0, 0, 0, 0, 0, 0, 0];
      for (const o of orders) {
        const d = new Date(o.scheduled_for);
        if (!isNaN(d.getTime())) counts[d.getDay()]++;
      }
      const total = counts.reduce((a, b) => a + b, 0);
      if (!total) {
        return finish("I don't have enough order history yet to call a slowest day. Tell me which day feels slow and I will build a drop for it.",
          null, "slow_days", "deterministic", {});
      }
      let slowest = 0;
      for (let i = 1; i < 7; i++) if (counts[i] < counts[slowest]) slowest = i;
      return finish(
        `Your slowest day in recent orders is ${days[slowest]} (${counts[slowest]} orders, out of ${total} total). Want a drop for next ${days[slowest]}? Tell me the item and the price you have in mind.`,
        null, "slow_days", "deterministic", { orders: total });
    }

    if (/best seller|best-selling|top seller|what sells best/.test(lower)) {
      const offers = await rest(
        "dm_offers?select=title,quantity_claimed,quantity_total,member_price_cents,holiday:dm_holidays!inner(business_id)" +
          "&holiday.business_id=eq." + enc + "&order=quantity_claimed.desc&limit=3",
        serviceKey
      ).catch(() => []);
      const ranked = (offers || []).filter((o) => (o.quantity_claimed || 0) > 0);
      if (!ranked.length) {
        return finish("Nothing has claims yet, so there is no best seller to name. Your first holiday will set the baseline.",
          null, "best_sellers", "deterministic", {});
      }
      const lines = ranked.map((o) =>
        `${o.title} (${o.quantity_claimed} claimed${o.member_price_cents != null ? ` at ${money(o.member_price_cents)}` : ""})`);
      return finish("Your best sellers by claims:\n" + lines.join("\n"), null, "best_sellers", "deterministic", { offers: ranked.length });
    }

    // ---------- LLM path (grounded proposal) ----------
    const groqKey = process.env.GROQ_API_KEY;
    let holidays = [];
    let packages = [];
    let orders = [];
    try {
      holidays = await rest(
        "dm_holidays?business_id=eq." + enc +
          "&select=id,title,description,starts_at,ends_at,status,dm_offers(id,title,details,regular_price_cents,member_price_cents,quantity_total,quantity_claimed,status)" +
          "&order=starts_at.desc&limit=20",
        serviceKey
      );
    } catch { holidays = []; }
    try {
      packages = await rest(
        "dm_packages?business_id=eq." + enc +
          "&select=name,description,serves_min,serves_max,base_price_cents,active&active=eq.true&limit=10",
        serviceKey
      );
    } catch { packages = []; }
    try {
      orders = await rest(
        "dm_orders?business_id=eq." + enc +
          "&select=title,scheduled_for,headcount,total_cents,status&order=scheduled_for.desc&limit=20",
        serviceKey
      );
    } catch { orders = []; }

    const offerIds = [];
    for (const h of holidays) for (const o of h.dm_offers || []) offerIds.push(o.id);
    let claimCounts = {};
    if (offerIds.length) {
      try {
        const reds = await rest(
          "dm_redemptions?offer_id=in.(" + offerIds.join(",") + ")&select=offer_id,status&limit=500",
          serviceKey
        );
        for (const r of reds) claimCounts[r.offer_id] = (claimCounts[r.offer_id] || 0) + 1;
      } catch { claimCounts = {}; }
    }

    const context = {
      business: {
        name: biz.name, tagline: biz.tagline, description: biz.description,
        menu_items: ((biz.station_data && biz.station_data.menu_items) || []).slice(0, 50).map((m) => ({
          name: m.name, price_cents: m.price_cents,
        })),
      },
      past_holidays: holidays.map((h) => ({
        title: h.title, description: h.description, starts_at: h.starts_at, ends_at: h.ends_at, status: h.status,
        offers: (h.dm_offers || []).map((o) => ({
          title: o.title, details: o.details, regular_price_cents: o.regular_price_cents,
          member_price_cents: o.member_price_cents, quantity_total: o.quantity_total,
          quantity_claimed: o.quantity_claimed, redemptions: claimCounts[o.id] || 0, status: o.status,
        })),
      })),
      packages: packages.map((p) => ({
        name: p.name, description: p.description, serves_min: p.serves_min,
        serves_max: p.serves_max, base_price_cents: p.base_price_cents,
      })),
      recent_orders: orders.map((o) => ({
        title: o.title, scheduled_for: o.scheduled_for, headcount: o.headcount,
        total_cents: o.total_cents, status: o.status,
      })),
    };
    const dataUsed = { holidays: holidays.length, offers: offerIds.length, packages: packages.length, orders: orders.length };

    const fallback = () => {
      const ranked = [];
      for (const h of holidays) {
        for (const o of h.dm_offers || []) {
          if ((o.quantity_claimed || 0) > 0) ranked.push(o);
        }
      }
      ranked.sort((a, b) => (b.quantity_claimed || 0) - (a.quantity_claimed || 0));
      if (ranked.length) {
        return `The model could not be reached, so here is what your own data says. Your best seller so far is ${ranked[0].title} (${ranked[0].quantity_claimed} claimed). Repeating that item at its last price is the safest next holiday. Tell me the day and I will build it.`;
      }
      return "The model could not be reached, and there is not enough history yet to fall back on. Use the manual holiday form for now: pick the item, the price, and the window, then submit it for review.";
    };

    if (!groqKey) {
      return finish(fallback(), null, "fallback", "fallback", dataUsed);
    }

    const today = new Date().toISOString().slice(0, 10);
    const system =
      "You are DayMarket's sales agent for a donut shop. Use ONLY the business data provided and the manager's words. Never invent prices, menu items, or past results. Member price must be at or below regular price. Prefer what actually sold before: items and price points with real claims, and morning windows (the shop opens at 5 AM) unless the manager says otherwise. Keep replies short and plain, like texting. If the manager asks to change an existing draft offer's price or cap, return an edit proposal instead of a new holiday. Return ONLY a JSON object, no markdown, no explanation: " +
      '{"type": "holiday", "title": "...", "description": "...", "starts_at": "ISO datetime or null", ' +
      '"ends_at": "ISO datetime or null", "offers": [{"title": "...", "details": "...", ' +
      '"regular_price_cents": 1499, "member_price_cents": 1099, "quantity_total": 25}]} ' +
      'or {"type": "edit", "target_offer_title": "...", "member_price_cents": 1099, "quantity_total": 30}. ' +
      "Up to 3 offers. quantity_total null means unlimited. If the manager is only asking a question, return the holiday object with just a title and no offers is wrong; instead return {\"type\": \"answer\", \"text\": \"...\"} with a short grounded answer.";
    const userMsg = "Today is " + today + ". Business data:\n" + JSON.stringify(context) + "\nManager message: " + message;

    let text = "";
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      const groqRes = await fetch(GROQ_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + groqKey },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userMsg },
          ],
          max_tokens: 900,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (groqRes.ok) {
        const groqData = await groqRes.json();
        text = (groqData.choices && groqData.choices[0] && groqData.choices[0].message
          ? groqData.choices[0].message.content : "") || "";
      }
    } catch (e) {
      console.log("LLM call failed, using fallback:", e.message);
    }
    text = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

    let raw = null;
    try {
      raw = JSON.parse(text);
    } catch {
      return finish(fallback(), null, "fallback", "fallback", dataUsed);
    }
    if (raw && raw.type === "answer" && typeof raw.text === "string" && raw.text.trim()) {
      return finish(raw.text.trim(), null, "answer", "llm", dataUsed);
    }
    const proposal = cleanProposal(raw);
    if (!proposal) {
      return finish(fallback(), null, "fallback", "fallback", dataUsed);
    }
    const reply = proposal.type === "edit"
      ? `Here is that change, ready to apply: ${proposal.label}. Nothing changes until you tap apply.`
      : "Here is a holiday built from what actually sold. Check it, then use it to fill the form.";
    return finish(reply, proposal, "proposal", "llm", dataUsed);
  } catch (e) {
    return json(500, { error: "Something went wrong. Use the manual form for now." });
  }
};
