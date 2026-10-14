/* Readable Station Gate 2 — pipeline core (channel-agnostic).
   Runs identically over voice transcripts and SMS text.

   Flow: intent classification -> structured extraction -> deterministic
   validation -> confidence scoring -> auto-approve | human review | clarify.
   Grounding rule is law: the agent answers only from the business's
   structured data. Anything else -> "I'll have someone text you."

   v1 is deterministic (keyword intent + structured data). The stage
   interfaces below are the contract: an LLM layer can replace
   classifyIntent/extractOrder later without changing the pipeline.

   Pure stages are exported for tests. runPipeline takes injected deps so
   tests never touch live data:
     event: { business_ref, caller_phone, text, channel: 'voice'|'sms',
              buyer_email?, idempotency_key? }
     deps:  { getBusinessData(ref), resolveBuyer(email),
              invokeCateringGate(orderInput), queueReview(payload),
              writeVerification(rec), findVerification(agentRef), now() }
*/

const { sha256, canonical, normalizePhone } = require("./station-lib");

const AUTO_APPROVE_CONFIDENCE = 0.85;

/* ==================== LLM understanding layer ==================== */
/* Replaces regex intent classification with real language understanding.
   The LLM interprets what the caller means; all facts (prices, menu items,
   packages) come from the business data loaded per-call. The LLM never
   invents business facts. */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "openai/gpt-oss-120b";

async function callLLM(messages, maxTokens) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        max_tokens: maxTokens || 300,
        temperature: 0.2,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

function businessContext(bd) {
  const menu = (bd.menu_items || []).map((i) => `${i.name} ($${((i.price_cents || 0) / 100).toFixed(2)})`).join(", ");
  const pkgs = (bd.packages || []).map((p) => `${p.name} ($${((p.base_price_cents || 0) / 100).toFixed(2)})`).join(", ");
  return `Business: ${bd.name || "the shop"}. Menu: ${menu || "none listed"}. Packages: ${pkgs || "none listed"}. Hours: ${bd.hours_text || "unknown"}. Address: ${bd.address || "unknown"}.`;
}

async function understandWithLLM(text, businessData) {
  const ctx = businessContext(businessData);
  const prompt =
    `You are interpreting a phone caller's words for ${businessData.name || "a shop"}. ` +
    `Context: ${ctx}\n\n` +
    `Caller said: "${text}"\n\n` +
    `Reply ONLY as JSON: {"intent": "order"|"question"|"greeting"|"conversational"|"unknown", ` +
    `"question_topic": "menu"|"packages"|"hours"|"location"|"price"|"specials"|null, ` +
    `"package_name": "exact package name if they named one, else null", ` +
    `"summary": "one sentence on what they want"}. ` +
    `Use "conversational" when the caller is signaling intent without content yet: ` +
    `"I have a question", "can I ask you something", "are you there", "hold on", etc. ` +
    `No other text.`;

  const raw = await callLLM([{ role: "user", content: prompt }], 200);
  if (!raw) return null;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/* ==================== Stage 1: intent classification ==================== */
/* LLM-powered with regex fallback. */

const ORDER_WORDS = /\b(dozen|order|pickup|pick up|deliver|want|need|get me|can i get|i'd like|i would like|i wanna|gimme|bring me)\b/i;
const QUESTION_WORDS = /\b(hours|open|close|when|where|location|address|price|cost|how much|menu|do you have|do you sell|what time)\b/i;
const GREETING_RE = /^(hi|hey|hello|good (morning|afternoon|evening)|yo)\b/i;
const QTY_RE = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an|half)\s*(dozen|dozens)?/i;

function classifyIntent(text) {
  const t = String(text || "").trim();
  if (!t) return { intent: "unknown", confidence: 0, rationale: "empty text" };
  const hasOrder = ORDER_WORDS.test(t);
  const hasQty = QTY_RE.test(t);
  const hasQuestion = QUESTION_WORDS.test(t);
  if (hasOrder && hasQty) {
    return { intent: "order", confidence: 0.7, rationale: "order words + quantity" };
  }
  if (hasOrder) {
    return { intent: "order", confidence: 0.55, rationale: "order words, no quantity" };
  }
  if (hasQuestion) {
    return { intent: "question", confidence: 0.7, rationale: "question words" };
  }
  if (GREETING_RE.test(t) && t.length < 30) {
    return { intent: "greeting", confidence: 0.8, rationale: "greeting only" };
  }
  return { intent: "unknown", confidence: 0.3, rationale: "no signal matched" };
}

/* ==================== Stage 2: structured extraction ==================== */

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
function parseQty(token) {
  const t = String(token).toLowerCase();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (t === "half") return 0.5;
  return NUMBER_WORDS[t] !== undefined ? NUMBER_WORDS[t] : null;
}

/* Find "<qty> [dozen] <item>" patterns against the business menu. */
function extractOrder(text, businessData) {
  const t = String(text || "");
  const items = [];
  const menu = (businessData && businessData.menu_items) || [];
  const packages = (businessData && businessData.packages) || [];

  /* Package name matching: "the Morning Meeting package", "Huddle Box", etc. */
  let matchedPackage = null;
  const tl = t.toLowerCase();
  for (const pkg of packages) {
    const pname = String(pkg.name || "").toLowerCase();
    if (pname && tl.includes(pname)) {
      matchedPackage = pkg;
      break;
    }
  }
  /* qty token: must start after whitespace/comma/start, must not run into
     word chars or colons, and must not be a time expression ("9am"). */
  const pat = /(?:^|(?<=[\s,]))(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an|half)(?![\w:])(?!\s*(?::\d{2})?\s*[ap]m\b)\s*(dozen|dozens)?\s*(?:of\s+)?([a-z][a-z\s'-]*?)(?=\s*(?:,|&|\+|$|\band\b|\bfor\b|\bat\b|[.!?]))/gi;
  let m;
  const seen = new Set();
  while ((m = pat.exec(t)) !== null) {
    const qty = parseQty(m[1]);
    if (qty === null || qty <= 0) continue;
    const unit = m[2] ? "dozen" : "each";
    const phrase = m[3].trim().toLowerCase();
    if (!phrase || seen.has(m.index)) continue;
    seen.add(m.index);
    const matched = matchMenuItem(phrase, menu);
    items.push({
      phrase,
      qty: m[2] ? qty : qty, // dozen multiplier applied at confirmation/pricing
      unit,
      menu_item: matched ? matched.name : null,
      price_cents: matched && matched.price_cents != null ? matched.price_cents : null,
      generic: !matched && GENERIC_CATEGORY_WORDS.has(phrase),
    });
  }
  /* pickup time: "for 9am", "at 9:30", "tomorrow", "today", "in the morning" */
  let pickup_text = null;
  let pickup = null;
  const tp = t.match(/\b(?:for|at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (tp) {
    pickup_text = tp[0];
    pickup = { hour: parseInt(tp[1], 10), minute: tp[2] ? parseInt(tp[2], 10) : 0, meridiem: (tp[3] || "").toLowerCase() || null, raw: tp[0] };
  } else if (/\btomorrow\b/i.test(t)) {
    pickup_text = "tomorrow";
    pickup = { relative: "tomorrow", raw: "tomorrow" };
  }
  /* name hint: "this is X", "name is X", "I'm X" */
  let name_hint = null;
  const nm = t.match(/\b(?:this is|name is|i'm|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (nm) name_hint = nm[1];

  /* delivery vs pickup detection */
  let fulfillment = null; // "delivery" | "pickup" | null
  let deliveryAddress = null;
  if (/\bdeliver(y|ed)?\b/i.test(t)) fulfillment = "delivery";
  else if (/\bpick\s?up\b/i.test(t)) fulfillment = "pickup";
  // Try to extract a street address for delivery
  const addrMatch = t.match(/\b\d+\s+[A-Za-z0-9\s]+(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|circle|cir|court|ct|parkway|pkwy)[A-Za-z0-9\s,]*\b/i);
  if (addrMatch) deliveryAddress = addrMatch[0].trim();

  return { items, pickup_text, pickup, name_hint, matchedPackage, fulfillment, deliveryAddress, raw: t };
}

/* Words that name the category but not a specific menu item. These should
   prompt "what kind?" rather than failing as not-on-menu. */
const GENERIC_CATEGORY_WORDS = new Set(["donut", "donuts", "doughnut", "doughnuts"]);

function matchMenuItem(phrase, menu) {
  if (!menu || !menu.length) return null;
  const p = phrase.toLowerCase();
  for (const item of menu) {
    const names = [item.name].concat(item.aliases || []).map((s) => String(s).toLowerCase());
    for (const n of names) {
      if (!n) continue;
      const re = new RegExp("\\b" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
      if (re.test(p)) return item;
    }
  }
  return null;
}

/* ==================== Stage 2b: question answering (grounded) ==================== */

/* Answer using LLM-detected topic, falling back to regex patterns. */
function answerQuestionWithTopic(text, businessData, topic) {
  const bd = businessData || {};
  // LLM already told us the topic — answer directly from business data
  if (topic === "menu" || topic === "specials") {
    const menu = bd.menu_items || [];
    if (menu.length) {
      return { answer: `${bd.name} menu: ${menu.slice(0, 8).map((i) => i.name).join(", ")}.` };
    }
    return { unknown: true };
  }
  if (topic === "packages") {
    const pkgs = bd.packages || [];
    if (pkgs.length) {
      const list = pkgs.slice(0, 6).map((p) => `${p.name} $${((p.base_price_cents || 0) / 100).toFixed(2)}`).join(", ");
      return { answer: `Available packages: ${list}.` };
    }
    return { unknown: true };
  }
  if (topic === "hours") {
    if (bd.hours_text) return { answer: `${bd.name} hours: ${bd.hours_text}.` };
    return { unknown: true };
  }
  if (topic === "location") {
    if (bd.address) return { answer: `${bd.name} is at ${bd.address}.` };
    return { unknown: true };
  }
  if (topic === "price") {
    // Try to match a specific item, else list menu prices
    const menu = bd.menu_items || [];
    const t = String(text || "").toLowerCase();
    for (const item of menu) {
      if (item.price_cents != null && t.includes(item.name.toLowerCase())) {
        return { answer: `${item.name} is $${(item.price_cents / 100).toFixed(2)}.` };
      }
    }
    return { unknown: true };
  }
  // Fall back to regex-based answering
  return answerQuestion(text, businessData);
}

function answerQuestion(text, businessData) {
  const t = String(text || "").toLowerCase();
  const bd = businessData || {};
  if (/\b(hours|open|close|what time)\b/.test(t)) {
    if (bd.hours_text) return { answer: `${bd.name} hours: ${bd.hours_text}.` };
    return { unknown: true };
  }
  if (/\b(where|location|address|find you)\b/.test(t)) {
    if (bd.address) return { answer: `${bd.name} is at ${bd.address}.` };
    return { unknown: true };
  }
  if (/\b(price|cost|how much)\b/.test(t)) {
    const menu = bd.menu_items || [];
    for (const item of menu) {
      if (item.price_cents != null && new RegExp("\\b" + item.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(t)) {
        return { answer: `${item.name} is $${(item.price_cents / 100).toFixed(2)}.` };
      }
    }
    return { unknown: true };
  }
  if (/\bmenu\b/.test(t) || /\bwhat (do you|do u|you) (have|got|sell|offer)\b/.test(t) || /\bwhat('s| is) (your|the) (special|deal|offer)/.test(t) || /\b(specials?|deals?|offerings?)\b/.test(t)) {
    const menu = bd.menu_items || [];
    if (menu.length) {
      return { answer: `${bd.name} menu: ${menu.slice(0, 8).map((i) => i.name).join(", ")}.` };
    }
    return { unknown: true };
  }
  if (/\bpackages?\b/.test(t) || /\bwhat (packages?|boxes|bundles|catering)/.test(t)) {
    const pkgs = bd.packages || [];
    if (pkgs.length) {
      const list = pkgs.slice(0, 6).map((p) => `${p.name} $${((p.base_price_cents || 0) / 100).toFixed(2)}`).join(", ");
      return { answer: `Available packages: ${list}.` };
    }
    return { unknown: true };
  }
  return { unknown: true };
}

/* ==================== Stage 3: deterministic validation ==================== */

function validateOrder(structured, businessData, nowMs) {
  const issues = [];
  const suggestions = [];
  const bd = businessData || {};
  const menu = bd.menu_items || [];
  // If the caller named a specific package, no individual items are required
  const hasPackage = !!(structured.matchedPackage && structured.matchedPackage.name);
  if (!structured.items.length && !hasPackage) {
    issues.push({ code: "no_items", message: "No order items detected." });
  }
  // Delivery or pickup must be specified for orders
  const hasOrder = structured.items.length > 0 || hasPackage;
  if (hasOrder && !structured.fulfillment) {
    issues.push({ code: "no_fulfillment", message: "Delivery or pickup not specified.", soft: true });
  }
  // Delivery requires an address
  if (hasOrder && structured.fulfillment === "delivery" && !structured.deliveryAddress) {
    issues.push({ code: "no_address", message: "Delivery address not provided.", soft: true });
  }
  for (const it of structured.items) {
    if (!Number.isFinite(it.qty) || it.qty <= 0 || it.qty > 200) {
      issues.push({ code: "bad_qty", message: `Quantity not sane: ${it.phrase}.` });
    }
    if (it.generic) {
      issues.push({ code: "generic_category", message: `'${it.phrase}' needs a specific kind.` });
    } else if (menu.length && !it.menu_item) {
      issues.push({ code: "item_not_on_menu", message: `'${it.phrase}' is not on the menu.` });
      if (menu.length) suggestions.push(menu[0].name);
    }
    if (!menu.length) {
      issues.push({ code: "menu_unseeded", message: "Menu not seeded for this business; items cannot be verified.", soft: true });
    }
  }
  if (structured.pickup && structured.pickup.hour != null) {
    let h = structured.pickup.hour;
    const mer = structured.pickup.meridiem;
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    if (h < 0 || h > 23) issues.push({ code: "bad_time", message: "Pickup time not parseable." });
    /* hours check only when hours are known */
    if (bd.hours && bd.hours.open_hour != null && bd.hours.close_hour != null) {
      if (h < bd.hours.open_hour || h >= bd.hours.close_hour) {
        issues.push({ code: "outside_hours", message: `Pickup ${structured.pickup.raw} is outside business hours.` });
      }
    }
  }
  const hard = issues.filter((i) => !i.soft);
  return { valid: hard.length === 0, issues, suggestions: [...new Set(suggestions)] };
}

/* ==================== Stage 4: confidence + decision ==================== */

function scoreConfidence(classification, extraction, validation) {
  let c = classification.confidence || 0;
  if (classification.intent === "order") {
    if (!extraction.items.length) c -= 0.2;
    if (!extraction.pickup_text) c -= 0.1;
    const menuUnseeded = validation.issues.some((i) => i.code === "menu_unseeded");
    if (menuUnseeded) c = Math.min(c, 0.7); // grounding rule: unverifiable items can never auto-approve
    c -= 0.3 * validation.issues.filter((i) => !i.soft).length;
  }
  return Math.max(0, Math.min(0.95, c));
}

function decide({ intent, confidence, validation, buyerResolvable, questionAnswered }) {
  if (intent === "question") return questionAnswered ? "answered" : "escalate";
  if (intent === "greeting") return "greet";
  if (intent !== "order") return "escalate";
  if (!validation.valid) return "clarify";
  // Soft fulfillment issues need clarification before proceeding
  const codes = (validation.issues || []).map((i) => i.code);
  if (codes.includes("no_fulfillment") || codes.includes("no_address")) return "clarify";
  if (confidence >= AUTO_APPROVE_CONFIDENCE && buyerResolvable) return "auto_approve";
  return "human_review";
}

/* ==================== Stage 5: truthful replies ==================== */

function itemsText(items) {
  return items.map((i) => `${i.qty} ${i.unit === "dozen" ? "dozen" : ""} ${i.menu_item || i.phrase}`.replace(/\s+/g, " ").trim()).join(", ");
}
function buildReply(decision, ctx) {
  const bd = ctx.businessData || {};
  const name = bd.name || "the shop";
  switch (decision) {
    case "auto_approve": {
      const pkg = ctx.structured.matchedPackage && ctx.structured.matchedPackage.name;
      const it = itemsText(ctx.structured.items);
      const when = ctx.structured.pickup_text ? ` for pickup ${ctx.structured.pickup_text}` : "";
      const fulfillment = ctx.structured.fulfillment;
      let what;
      if (pkg) {
        what = `the ${pkg} package`;
      } else if (ctx.customPkg) {
        what = `a custom package with ${it}`;
      } else {
        what = it;
      }
      if (fulfillment === "delivery") {
        // Calculate delivery fee based on dozens
        let dozens = 0;
        for (const item of ctx.structured.items) {
          if (item.unit === "dozen") dozens += item.qty;
        }
        const fee = deliveryFee(dozens);
        const addr = ctx.structured.deliveryAddress ? ` to ${ctx.structured.deliveryAddress}` : "";
        return `Got it. ${what} with delivery${addr}${when}. Delivery fee is $${fee}. We'll have it ready.`;
      }
      return `Got it. ${what}${when}. We'll have it ready. Pay at pickup.`;
    }
    case "human_review": {
      const it = ctx.structured.items.length ? itemsText(ctx.structured.items) : "your order";
      return `I've got your order: ${it}. The shop will confirm by text shortly.`;
    }
    case "clarify": {
      const issues = (ctx.validation && ctx.validation.issues) || [];
      const codes = issues.map((i) => i.code);
      const onlyNoItems = codes.includes("no_items") && !codes.includes("item_not_on_menu") && !codes.includes("generic_category") && !codes.includes("bad_qty");
      if (onlyNoItems) {
        return `What can I get for you?`;
      }
      if (codes.includes("no_fulfillment")) {
        return `Do you need delivery or pickup?`;
      }
      if (codes.includes("no_address")) {
        return `What's the delivery address? Delivery is $35.`;
      }
      if (codes.includes("generic_category")) {
        const menuNames = ((ctx.businessData && ctx.businessData.menu_items) || []).slice(0, 5).map((i) => i.name);
        const alt = menuNames.length ? ` We have ${menuNames.join(", ")}.` : "";
        return `What kind?${alt}`;
      }
      const sug = (ctx.validation.suggestions || []).slice(0, 3);
      const alt = sug.length ? ` We have ${sug.join(", ")}.` : "";
      return `I couldn't match that to the menu.${alt} What would you like?`;
    }
    case "answered":
      return ctx.answer;
    case "escalate":
      return `I don't know that one. I'll have someone from ${name} text you.`;
    case "conversational":
      return `Sure, go ahead. What's your question?`;
    case "greet":
      return `Hi, this is ${name}. Are you placing an order or do you have a question?`;
    case "rejected":
      return `Sorry, we're not taking orders right now.`;
    default:
      return `Thanks for reaching out to ${name}. Someone will be with you shortly.`;
  }
}

/* ==================== Custom package building ==================== */
/* When the caller lists items without naming a package, build a custom package
   just like the sales agent does: base price + 10% custom premium. */

const CUSTOM_PREMIUM_BPS = 1000; // 10%
const DELIVERY_FLOOR = 35;
const DELIVERY_INCLUDED_DOZEN = 3;
const DELIVERY_PER_DOZEN = 4;

function deliveryFee(dozens) {
  const dz = dozens || 0;
  if (dz <= DELIVERY_INCLUDED_DOZEN) return DELIVERY_FLOOR;
  return DELIVERY_FLOOR + Math.round((dz - DELIVERY_INCLUDED_DOZEN) * DELIVERY_PER_DOZEN);
}

async function buildCustomPackage(serviceKey, businessData, items, callerPhone) {
  const { sb } = require("./station-lib");
  const q = (m, p, b) => sb(serviceKey, m, p, b);

  // Calculate base price from matched menu items
  let baseCents = 0;
  const cleanItems = [];
  for (const it of items) {
    if (!it.menu_item || it.price_cents == null) continue;
    // Convert dozen to individual units for pricing (menu prices are per item)
    const units = it.unit === "dozen" ? it.qty * 12 : it.qty;
    const lineTotal = units * it.price_cents;
    baseCents += lineTotal;
    cleanItems.push({
      name: it.menu_item,
      qty: units,
      unit_price_cents: it.price_cents,
    });
  }
  if (!baseCents || !cleanItems.length) return null;

  const premiumCents = Math.round((baseCents * CUSTOM_PREMIUM_BPS) / 10000);
  const priceCents = baseCents + premiumCents;
  const itemList = cleanItems.map((i) => `${i.qty}x ${i.name}`).join(", ");

  // Create the custom package
  const pkgRes = await q("POST", "/dm_packages", {
    business_id: businessData.id,
    name: `Custom Phone Order`,
    description: `Custom bundle: ${itemList}. Built via phone.`,
    base_price_cents: priceCents,
    is_custom: true,
    active: true,
    custom_source: {
      items: cleanItems,
      base_cents: baseCents,
      premium_bps: CUSTOM_PREMIUM_BPS,
      premium_cents: premiumCents,
      built_via: "voice",
      caller_phone: callerPhone,
      built_at: new Date().toISOString(),
    },
  });

  if (pkgRes.status === 201 && pkgRes.data && pkgRes.data[0]) {
    return pkgRes.data[0];
  }
  return null;
}

/* ==================== Orchestration ==================== */

async function defaultGetBusinessData(serviceKey, businessRef, sbFn) {
  const { sb } = require("./station-lib");
  const q = (m, p, b) => sb(serviceKey, m, p, b);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const f = UUID_RE.test(businessRef) ? "id=eq." + businessRef : "slug=eq." + encodeURIComponent(businessRef);
  const bRes = await q("GET", "/dm_businesses?" + f + "&select=id,name,slug,status,station_data");
  const biz = bRes.status === 200 && bRes.data && bRes.data[0];
  if (!biz) return null;
  const pRes = await q("GET", "/dm_packages?active=eq.true&select=id,name,base_price_cents");
  const packages = pRes.status === 200 ? pRes.data || [] : [];
  /* Operator-seeded structured data (hours, phone, menu, address).
     Primary source is the station_data column on dm_businesses;
     the STATION_BUSINESS_DATA env var remains as a fallback. */
  let seeded = (biz.station_data && typeof biz.station_data === "object") ? biz.station_data : {};
  if (!seeded.menu_items) {
    try {
      const all = JSON.parse(process.env.STATION_BUSINESS_DATA || "{}");
      seeded = all[biz.slug] || {};
    } catch { /* ignore bad JSON */ }
  }
  return {
    id: biz.id,
    name: biz.name,
    slug: biz.slug,
    status: biz.status,
    phone: seeded.phone || null,
    address: seeded.address || null,
    hours_text: seeded.hours_text || null,
    hours: seeded.hours || null,
    menu_items: seeded.menu_items || [],
    packages,
  };
}

async function runPipeline(event, deps) {
  const now = (deps.now && deps.now()) || Date.now();
  const channel = event.channel === "voice" ? "voice" : "sms";
  const callerPhone = normalizePhone(event.caller_phone);
  const base = {
    business_ref: event.business_ref,
    caller_phone: callerPhone,
    channel,
    text: String(event.text || ""),
  };
  const inputsHash = sha256(canonical(base));

  /* idempotency: same key returns the original run */
  if (event.idempotency_key && deps.findVerification) {
    const prev = await deps.findVerification(event.idempotency_key);
    if (prev && prev.inputs_hash === inputsHash) {
      return { ok: true, duplicate: true, decision: prev.event_type, reply: prev.reply_text || null };
    }
    if (prev && prev.inputs_hash !== inputsHash) {
      return { ok: false, error: "idempotency_key_reused" };
    }
  }

  const businessData = await deps.getBusinessData(event.business_ref);
  if (!businessData || businessData.status !== "active") {
    return { ok: false, error: "business_not_found", decision: "rejected", reply: buildReply("rejected", {}) };
  }

  const classification = classifyIntent(base.text);

  /* Try LLM understanding for richer intent detection */
  let llmIntent = null;
  try {
    llmIntent = await understandWithLLM(base.text, businessData);
  } catch { /* fall back to regex */ }

  // LLM overrides regex when it has a clear answer
  const effectiveIntent = (llmIntent && llmIntent.intent && llmIntent.intent !== "unknown")
    ? { intent: llmIntent.intent, confidence: 0.85, rationale: "llm: " + (llmIntent.summary || ""), llm: llmIntent }
    : classification;
  const verify = async (eventType, extra) => {
    if (!deps.writeVerification) return null;
    return deps.writeVerification(
      Object.assign(
        {
          order_id: null,
          endpoint: channel === "voice" ? "/api/station/voice" : "/api/station/sms",
          channel,
          event_type: eventType,
          inputs_hash: inputsHash,
          status: "processed",
          agent_ref: event.idempotency_key || null,
          caller_phone: callerPhone,
          business_id: businessData.id,
        },
        extra || {}
      )
    );
  };

  /* ---- question branch ---- */
  if (effectiveIntent.intent === "question" || effectiveIntent.intent === "greeting" || effectiveIntent.intent === "unknown" || effectiveIntent.intent === "conversational") {
    // Conversational openers: invite the caller to continue, don't give up
    if (effectiveIntent.intent === "conversational") {
      const decision = "conversational";
      const reply = buildReply(decision, { businessData });
      const ver = await verify("conversational", { reply_text: reply });
      return { ok: true, decision, reply, confidence: effectiveIntent.confidence, verification: ver };
    }
    if (effectiveIntent.intent === "question") {
      // Use LLM topic if available, else regex
      const topic = (effectiveIntent.llm && effectiveIntent.llm.question_topic) || null;
      const qa = answerQuestionWithTopic(base.text, businessData, topic);
      if (!qa.unknown) {
        const decision = decide({ intent: "question", questionAnswered: true });
        const reply = buildReply(decision, { businessData, answer: qa.answer });
        const ver = await verify("question_answered", { reply_text: reply });
        return { ok: true, decision, reply, confidence: effectiveIntent.confidence, verification: ver };
      }
    }
    const decision = decide({ intent: effectiveIntent.intent, questionAnswered: false });
    const reply = buildReply(decision, { businessData });
    const ver = await verify("question_escalated", { reply_text: reply });
    return { ok: true, decision, reply, confidence: effectiveIntent.confidence, verification: ver };
  }

  /* ---- order branch ---- */
  const structured = extractOrder(base.text, businessData);
  // If LLM detected a package name, use it
  if (effectiveIntent.llm && effectiveIntent.llm.package_name && !structured.matchedPackage) {
    const pname = effectiveIntent.llm.package_name.toLowerCase();
    for (const pkg of (businessData.packages || [])) {
      if (String(pkg.name || "").toLowerCase() === pname || String(pkg.name || "").toLowerCase().includes(pname)) {
        structured.matchedPackage = pkg;
        break;
      }
    }
  }
  /* menu match bonus to intent confidence */
  if (structured.items.some((i) => i.menu_item)) classification.confidence = Math.min(0.95, classification.confidence + 0.15);
  const validation = validateOrder(structured, businessData, now);

  let buyerResolvable = false;
  let buyer = null;
  if (event.buyer_email && deps.resolveBuyer) {
    buyer = await deps.resolveBuyer(event.buyer_email);
    buyerResolvable = !!buyer;
  }
  const confidence = scoreConfidence(classification, structured, validation);
  const decision = decide({ intent: "order", confidence, validation, buyerResolvable });

  if (decision === "auto_approve") {
    // Use the matched package if the caller named one.
    // If they listed items without naming a package, build a custom package.
    // Otherwise fall back to first package.
    let pkgName = (structured.matchedPackage && structured.matchedPackage.name) || null;
    let customPkg = null;

    if (!pkgName && structured.items.length) {
      // Build a custom package from the listed items
      const serviceKey = process.env.SUPABASE_SERVICE_KEY;
      if (serviceKey) {
        customPkg = await buildCustomPackage(serviceKey, businessData, structured.items, callerPhone);
        if (customPkg) pkgName = customPkg.name;
      }
    }
    if (!pkgName) {
      pkgName = (businessData.packages[0] || {}).name || "Morning Meeting";
    }

    const orderInput = {
      business: businessData.slug,
      package: pkgName,
      scheduled_for: new Date(now + 60 * 60 * 1000).toISOString(),
      buyer_email: event.buyer_email,
      contact: { name: structured.name_hint || "Phone order", phone: callerPhone },
      notes: "Station phone gate. Items: " + itemsText(structured.items) +
        (structured.pickup_text ? ". Pickup: " + structured.pickup_text : "") +
        (structured.fulfillment === "delivery" ? " [DELIVERY REQUESTED]" + (structured.deliveryAddress ? " Address: " + structured.deliveryAddress : "") : " [PICKUP]") +
        (customPkg ? " [Custom package built via phone]" : ""),
      idempotency_key: event.idempotency_key || undefined,
    };
    const created = await deps.invokeCateringGate(orderInput);
    if (!created || !created.ok) {
      /* gate failed: fall back to human review, never a dead end */
      const review = deps.queueReview
        ? await deps.queueReview(reviewPayload(businessData, callerPhone, channel, structured, validation, confidence, "gate_error"))
        : null;
      const ver = await verify("order_queued_review", { review_id: review && review.id });
      return { ok: true, decision: "human_review", reply: buildReply("human_review", { businessData, structured }), confidence, review, verification: ver };
    }
    const ver = await verify("order_auto_approved", { order_id: created.order.id });
    const reply = buildReply("auto_approve", { businessData, structured, customPkg });
    return { ok: true, decision, reply, confidence, order: created.order, verification: ver };
  }

  if (decision === "human_review") {
    const review = deps.queueReview
      ? await deps.queueReview(reviewPayload(businessData, callerPhone, channel, structured, validation, confidence, buyerResolvable ? "low_confidence" : "no_buyer_account"))
      : null;
    const ver = await verify("order_queued_review", { review_id: review && review.id });
    return { ok: true, decision, reply: buildReply("human_review", { businessData, structured }), confidence, review, verification: ver };
  }

  /* clarify */
  const ver = await verify("order_clarify");
  return { ok: true, decision, reply: buildReply("clarify", { businessData, validation }), confidence, verification: ver };
}

function reviewPayload(businessData, callerPhone, channel, structured, validation, confidence, reason) {
  return {
    business_id: businessData.id,
    caller_phone: callerPhone,
    channel,
    structured_order: structured,
    validation_notes: validation.issues.map((i) => i.code + ": " + i.message).join(" | ") || null,
    confidence,
    status: "pending",
    decided_at: null,
    review_reason: reason,
  };
}

module.exports = {
  runPipeline,
  defaultGetBusinessData,
  classifyIntent,
  extractOrder,
  matchMenuItem,
  answerQuestion,
  validateOrder,
  scoreConfidence,
  decide,
  buildReply,
  itemsText,
  reviewPayload,
  AUTO_APPROVE_CONFIDENCE,
};
