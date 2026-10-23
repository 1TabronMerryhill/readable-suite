/* DayMarket AI sells agent: build a holiday proposal from real business data.
   POST /.netlify/functions/ai-holiday (redirect: /api/daymarket/ai-holiday)

   The manager describes the situation (what is slow, what is extra, the goal).
   The function reads ONLY this business's own data (past holidays, offers,
   claims, packages, orders), asks Groq to assemble one holiday proposal, and
   returns it. Nothing is created, submitted, or published here. The manager
   reviews the proposal, creates the draft, and the operator still approves
   before anything goes live. Grounding rule: the model may only use the data
   handed to it plus the manager's own words. It must never invent prices,
   items, or past results.

   Env vars (Netlify dashboard, never committed):
     GROQ_API_KEY        — shared with the station functions
     SUPABASE_SERVICE_KEY — service-role key for Supabase REST reads
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

async function rest(path, serviceKey) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    headers: {
      apikey: serviceKey,
      Authorization: "Bearer " + serviceKey,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error("Supabase read failed: " + res.status);
  return res.json();
}

function toInt(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function cleanProposal(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  const startsAt =
    typeof raw.starts_at === "string" && !isNaN(Date.parse(raw.starts_at))
      ? raw.starts_at
      : null;
  const endsAt =
    typeof raw.ends_at === "string" && !isNaN(Date.parse(raw.ends_at))
      ? raw.ends_at
      : null;
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
    title,
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    starts_at: startsAt,
    ends_at: endsAt,
    offers,
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "POST only." });
    }
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    if (!serviceKey) return json(500, { error: "Server is not configured." });
    if (!groqKey) {
      return json(503, {
        error: "The AI agent is not connected yet. Use the manual form for now.",
      });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Bad request." });
    }
    const businessId = typeof body.business_id === "string" ? body.business_id : "";
    if (!businessId) return json(400, { error: "Missing business." });

    // Who is calling? The manager's own Supabase access token.
    const auth = event.headers.authorization || event.headers.Authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { error: "Sign in first." });
    const whoRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: serviceKey, Authorization: "Bearer " + token },
    });
    if (!whoRes.ok) return json(401, { error: "Sign in first." });
    const who = await whoRes.json();

    // Ownership check: only the business's owner may use the agent on it.
    const bizRows = await rest(
      "dm_businesses?id=eq." + encodeURIComponent(businessId) +
        "&select=id,owner_id,name,tagline,description",
      serviceKey
    );
    const biz = bizRows[0];
    if (!biz || biz.owner_id !== who.id) {
      return json(403, { error: "That business is not yours." });
    }

    // The data the agent is allowed to use. Each read tolerates failure;
    // the agent works with whatever actually came back, nothing else.
    let holidays = [];
    let packages = [];
    let orders = [];
    try {
      holidays = await rest(
        "dm_holidays?business_id=eq." + encodeURIComponent(businessId) +
          "&select=id,title,description,starts_at,ends_at,status,dm_offers(id,title,details,regular_price_cents,member_price_cents,quantity_total,quantity_claimed,status)" +
          "&order=starts_at.desc&limit=20",
        serviceKey
      );
    } catch { holidays = []; }
    try {
      packages = await rest(
        "dm_packages?business_id=eq." + encodeURIComponent(businessId) +
          "&select=name,description,serves_min,serves_max,base_price_cents,active&active=eq.true&limit=10",
        serviceKey
      );
    } catch { packages = []; }
    try {
      orders = await rest(
        "dm_orders?business_id=eq." + encodeURIComponent(businessId) +
          "&select=title,scheduled_for,headcount,total_cents,status&order=scheduled_for.desc&limit=20",
        serviceKey
      );
    } catch { orders = []; }

    // Claim counts per offer, from redemptions on this business's holidays.
    const offerIds = [];
    for (const h of holidays) {
      for (const o of h.dm_offers || []) offerIds.push(o.id);
    }
    let claimCounts = {};
    if (offerIds.length) {
      try {
        const reds = await rest(
          "dm_redemptions?offer_id=in.(" + offerIds.join(",") +
            ")&select=offer_id,status&limit=500",
          serviceKey
        );
        for (const r of reds) {
          claimCounts[r.offer_id] = (claimCounts[r.offer_id] || 0) + 1;
        }
      } catch { claimCounts = {}; }
    }

    const history = holidays.map((h) => ({
      title: h.title,
      description: h.description,
      starts_at: h.starts_at,
      ends_at: h.ends_at,
      status: h.status,
      offers: (h.dm_offers || []).map((o) => ({
        title: o.title,
        details: o.details,
        regular_price_cents: o.regular_price_cents,
        member_price_cents: o.member_price_cents,
        quantity_total: o.quantity_total,
        quantity_claimed: o.quantity_claimed,
        redemptions: claimCounts[o.id] || 0,
        status: o.status,
      })),
    }));

    const context = {
      business: {
        name: biz.name,
        tagline: biz.tagline,
        description: biz.description,
      },
      past_holidays: history,
      packages: packages.map((p) => ({
        name: p.name,
        description: p.description,
        serves_min: p.serves_min,
        serves_max: p.serves_max,
        base_price_cents: p.base_price_cents,
      })),
      recent_orders: orders.map((o) => ({
        title: o.title,
        scheduled_for: o.scheduled_for,
        headcount: o.headcount,
        total_cents: o.total_cents,
        status: o.status,
      })),
      manager_input: {
        slow_item: typeof body.slow_item === "string" ? body.slow_item : "",
        surplus: typeof body.surplus === "string" ? body.surplus : "",
        goal: typeof body.goal === "string" ? body.goal : "",
        notes: typeof body.notes === "string" ? body.notes : "",
      },
    };

    const today = new Date().toISOString().slice(0, 10);
    const system =
      "You assemble one DayMarket holiday proposal for a donut shop. " +
      "Use ONLY the business data and the manager input provided. Never invent " +
      "prices, menu items, or past results. Member price must be at or below " +
      "regular price. Prefer what actually sold before: items and price points " +
      "with real claims, and morning windows (the shop opens at 5 AM) unless " +
      "the manager says otherwise. Keep the title short and plain. Return ONLY " +
      "a JSON object, no markdown, no explanation: " +
      '{"title": "...", "description": "...", "starts_at": "ISO datetime or null", ' +
      '"ends_at": "ISO datetime or null", "offers": [{"title": "...", "details": "...", ' +
      '"regular_price_cents": 1499, "member_price_cents": 1099, ' +
      '"quantity_total": 25}]}. Up to 3 offers. quantity_total null means unlimited.';
    const userMsg =
      "Today is " + today + ". Business data and manager input:\n" +
      JSON.stringify(context);

    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + groqKey,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
        max_tokens: 900,
        temperature: 0.2,
      }),
    });
    if (!groqRes.ok) {
      return json(502, {
        error: "The AI agent could not be reached. Use the manual form for now.",
      });
    }
    const groqData = await groqRes.json();
    let text = (groqData.choices && groqData.choices[0] && groqData.choices[0].message
      ? groqData.choices[0].message.content : "") || "";
    text = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    let raw = null;
    try {
      raw = JSON.parse(text);
    } catch {
      return json(502, {
        error: "The AI agent gave an unreadable answer. Try again or use the manual form.",
      });
    }
    const proposal = cleanProposal(raw);
    if (!proposal) {
      return json(502, {
        error: "The AI agent gave an unusable answer. Try again or use the manual form.",
      });
    }
    return json(200, {
      proposal,
      data_used: {
        holidays: history.length,
        offers: offerIds.length,
        packages: packages.length,
        orders: orders.length,
      },
    });
  } catch (e) {
    return json(500, { error: "Something went wrong. Use the manual form for now." });
  }
};
