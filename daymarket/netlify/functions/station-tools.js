/* Readable Station — data tools for voice agents.
 *
 * This is the FACT layer, not the BRAIN. The voice agent (Retell) handles
 * conversation naturally with its own LLM. It calls these tools to get
 * truthful business data: menu, prices, packages, hours, location.
 *
 * Each action returns structured data. The agent speaks naturally using
 * these facts. It must NEVER invent prices, items, or hours.
 *
 * Actions:
 *   get_menu     -> menu items with prices
 *   get_packages -> catering packages with prices
 *   get_hours    -> business hours
 *   get_info     -> address, phone, name
 *   place_order  -> create an order (validated)
 *
 * Concierge (directory) actions — no business resolution required:
 *   lookup_directory    -> listings matching ONE caller intent, nothing else
 *   get_business_context -> load one listing (shop context or system facts)
 *   take_message        -> write a callback/message row (dm_callback_requests)
 *
 * Routing is enforced HERE, not just in the agent prompt: lookup_directory
 * only ever returns listings whose intents include the caller's intent.
 * A hungry caller gets food listings. They never see health, phone, or
 * systems listings, and hidden listings never surface at all.
 *
 * Auth: x-retell-secret header must match RETELL_FUNCTION_SECRET.
 * Uses Supabase REST API via fetch (no client dependency).
 */

const { normalizePhone, sendSms } = require("./station-lib");
const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://evmynxxvyafvnreaudpr.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RETELL_SECRET = process.env.RETELL_FUNCTION_SECRET;
const REST = SUPABASE_URL + "/rest/v1";

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

async function sbGet(table, query) {
  const url = `${REST}/${table}?${query}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) {
    // Never swallow backend errors as "not found": a 400/401 here used to
    // surface as a lying 404 business_not_found downstream. Throw instead so
    // the handler returns an honest 500 with the real cause.
    const txt = await res.text().catch(() => "");
    throw new Error(`Supabase GET ${table} failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function sbPost(table, row) {
  const url = `${REST}/${table}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase insert failed: ${txt}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

/* Insert without a read-back. return=representation forces the new row
 * through SELECT policies too, which public-intake tables (callback
 * requests) and operator-only tables (voice contexts) deliberately do
 * not grant. Callers that need an id mint it themselves. */
async function sbPostMinimal(table, row) {
  const url = `${REST}/${table}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase insert failed: ${txt}`);
  }
}

async function sbPatch(table, id, patch) {
  const url = `${REST}/${table}?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase patch failed: ${txt}`);
  }
}

/* Create a Stripe Checkout Session for an order */
async function createCheckoutSession({ amount_cents, order_id, business_name, customer_phone, description }) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY not configured");

  const params = new URLSearchParams({
    "payment_method_types[0]": "card",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][product_data][name]": description || `Order from ${business_name}`,
    "line_items[0][price_data][unit_amount]": String(amount_cents),
    "line_items[0][quantity]": "1",
    mode: "payment",
    success_url: `https://daymarket.tabronmerryhill.com/order/${order_id}?paid=1`,
    cancel_url: `https://daymarket.tabronmerryhill.com/order/${order_id}?cancelled=1`,
    "metadata[order_id]": order_id,
    "metadata[business]": business_name,
  });
  if (customer_phone) {
    params.set("metadata[customer_phone]", customer_phone);
  }

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Stripe API error: ${txt}`);
  }

  return res.json();
}

/* Gatekeeper loop: named humans responsible for the order gate.
 *
 * fulfillmentTypeFor: orders placed before the shop's production_start are
 * pre-orders (chefs aren't in yet), not ASAP tickets. production_start and
 * timezone live in business.station_data (e.g. "01:00", "America/Chicago").
 *
 * notifyGatekeepers: texts every active gatekeeper a ticket summary with a
 * signed confirm link. Tapping it confirms the order (no login) and fires
 * the customer confirmation text. Failures never break the order itself.
 */
function fulfillmentTypeFor(business) {
  const sd = business.station_data || {};
  const prodStart = sd.production_start; // "HH:MM"
  if (!prodStart) return "asap";
  const tz = sd.timezone || "America/Chicago";
  try {
    const nowStr = new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", timeZone: tz,
    });
    return nowStr < prodStart ? "preorder" : "asap";
  } catch (e) {
    return "asap";
  }
}

async function notifyGatekeepers({ business, order, items, totalCents, fulfillment, fType, confirmToken, callerPhone }) {
  let gks = [];
  try {
    gks = await sbGet(
      "dm_gatekeepers",
      `select=id,name,phone&business_id=eq.${encodeURIComponent(business.id)}&is_active=eq.true&order=role.asc`
    );
  } catch (e) {
    console.error("gatekeeper lookup failed:", e.message);
    return;
  }
  if (!gks || !gks.length) {
    console.log("gatekeeper notify: no gatekeepers for", business.slug || business.id);
    return;
  }
  const itemSummary = items
    .map((it) => `${it.quantity || it.qty || 1}x ${it.name || "item"}`)
    .join(", ")
    .slice(0, 120);
  const totalStr = totalCents > 0 ? ` $${(totalCents / 100).toFixed(2)}` : "";
  const kind = fType === "preorder" ? "Pre-order" : "New order";
  const when = fulfillment === "delivery" ? "delivery" : "pickup";
  for (const gk of gks) {
    if (!gk.phone) continue;
    const link = `https://daymarket.tabronmerryhill.com/.netlify/functions/confirm-order?t=${confirmToken}&g=${gk.id}`;
    const body = `${kind} for ${business.name}: ${itemSummary}${totalStr} (${when}). ${callerPhone}. ${gk.name}, tap to confirm: ${link}`;
    try {
      const sms = await sendSms(gk.phone, body);
      console.log("gatekeeper SMS", sms.ok ? "sent" : "failed", gk.name, order.id, sms.ok ? sms.sid : (sms.skipped || sms.error));
    } catch (e) {
      console.error("gatekeeper SMS error:", gk.name, e.message);
    }
  }
}

/* Resolve business from slug/ref or called number */
async function resolveBusiness(event) {
  const ref = event.business_ref;
  if (ref) {
    // PostgREST 400s the whole query if a non-UUID value lands in id.eq.
    // (invalid input syntax for type uuid). Only OR against id when the ref
    // is actually a UUID; otherwise match the slug alone.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
    const enc = encodeURIComponent(ref);
    const filter = isUuid ? `or=(slug.eq.${enc},id.eq.${enc})` : `slug=eq.${enc}`;
    const rows = await sbGet(
      "dm_businesses",
      `select=id,name,slug,phone_number,station_data,status&${filter}&status=eq.active&limit=1`
    );
    if (rows && rows.length) return rows[0];
  }

  const calledNumber = event.called_number || event.to_number;
  if (calledNumber) {
    const normalized = normalizePhone(calledNumber);
    const rows = await sbGet(
      "dm_businesses",
      `select=id,name,slug,phone_number,station_data,status&phone_number=eq.${encodeURIComponent(normalized)}&status=eq.active&limit=1`
    );
    if (rows && rows.length) return rows[0];
  }

  // Fallback: this backend serves the Ellianna's voice agent, and the model
  // sometimes omits business_ref (seen on place_order -> 404 business_not_found,
  // order lost, no payment link). Resolve the default shop instead of failing
  // the order. Explicit-but-unmatched refs still fall through to null below.
  // DEFAULT_BUSINESS_SLUG env overrides; the concierge agent will set its own.
  if (!ref) {
    const defSlug = process.env.DEFAULT_BUSINESS_SLUG || "elliannas-donut-shop";
    const rows = await sbGet(
      "dm_businesses",
      `select=id,name,slug,phone_number,station_data,status&slug=eq.${encodeURIComponent(defSlug)}&status=eq.active&limit=1`
    );
    if (rows && rows.length) return rows[0];
  }

  return null;
}

function formatMenu(business) {
  const items = (business.station_data && business.station_data.menu_items) || [];
  return items.map((i) => ({
    name: i.name,
    price: i.price_cents != null ? (i.price_cents / 100).toFixed(2) : null,
    price_display: i.price_cents != null ? `$${(i.price_cents / 100).toFixed(2)}` : "price not listed",
  }));
}

async function getPackages(businessId) {
  const FIELDS = "select=id,name,description,base_price_cents,serves_min,serves_max";
  // Business-specific packages first.
  let rows = await sbGet(
    "dm_packages",
    `${FIELDS}&business_id=eq.${encodeURIComponent(businessId)}&active=eq.true&order=base_price_cents`
  );
  if (!rows || !rows.length) {
    // Fallback: DayMarket's operator catalog (business_id NULL) belongs to
    // DayMarket itself and is sold across shops — e.g. the Meeting Box for
    // Milly's "ten people" call. Business-specific packages win when present.
    rows = await sbGet(
      "dm_packages",
      `${FIELDS}&business_id=is.null&active=eq.true&order=base_price_cents`
    );
  }
  return (rows || []).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.base_price_cents != null ? (p.base_price_cents / 100).toFixed(2) : null,
    price_display: p.base_price_cents != null ? `$${(p.base_price_cents / 100).toFixed(2)}` : "custom quoted",
    serves: p.serves_min && p.serves_max ? `${p.serves_min}-${p.serves_max} people` : null,
  }));
}

/* ------------------------------------------------------------------ *
 * Station directory — the concierge routing layer.
 *
 * The directory (dm_directory_listings) holds every business and system
 * the concierge may route to, each tagged with the caller intents it
 * serves. lookup_directory returns ONLY listings matching the caller's
 * intent, in priority order. That scoping is the product rule: a hungry
 * caller hears food options and nothing else. No cross-suggestion, ever.
 * Hidden listings (seeded but not market-ready) never surface.
 * ------------------------------------------------------------------ */

const INTENT_LABELS = {
  food_ordering: "ordering food",
  health: "health programs, labs, or coaching",
  business_phone: "a phone answering service for their business",
  business_systems: "business systems or workflow help",
};

// Keyword signals per intent, matched as substrings of the caller's words.
// The intent enum stays small and exact (concierge contract):
// food_ordering | health | business_phone | business_systems.
const INTENT_KEYWORDS = {
  food_ordering: [
    "donut", "doughnut", "hungry", "food", "eat", "breakfast", "lunch",
    "dinner", "brunch", "coffee", "catering", "bakery", "pastry",
    "pastries", "fritter", "dozen", "snack", "meal", "dessert", "cake",
  ],
  health: [
    "health", "fitness", "labs", "lab work", "blood work", "bloodwork",
    "doctor", "clinic", "weight", "coaching", "wellness", "hormone",
    "vitamin", "cholesterol", "get in shape",
  ],
  business_phone: [
    "missed call", "missed calls", "misses calls", "miss calls",
    "can't answer", "cant answer", "answering", "receptionist",
    "voicemail", "phone agent", "answer my calls", "answer the phone",
    "after hours", "front desk", "calls when",
  ],
  business_systems: [
    "workflow", "systems", "consulting", "sprint", "processes",
    "operations", "automation", "software",
  ],
};

// Owner phrasing with no specific need ("I own a shop, what can you do
// for me") is not an intent by itself: it narrows to the two owner-facing
// categories and the agent asks one clarifying question.
const OWNER_SIGNALS = [
  "i own", "my shop", "my store", "my restaurant", "my business",
  "business owner", "for my business", "i run a", "we run a",
];

function classifyIntent(query) {
  const q = String(query || "").toLowerCase();
  if (!q) return { intent: null, ambiguous: [] };
  const scores = {};
  for (const [intent, words] of Object.entries(INTENT_KEYWORDS)) {
    let s = 0;
    for (const w of words) if (q.includes(w)) s += 1;
    if (s > 0) scores[intent] = s;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) {
    if (OWNER_SIGNALS.some((w) => q.includes(w))) {
      return { intent: null, ambiguous: ["business_phone", "business_systems"] };
    }
    return { intent: null, ambiguous: [] };
  }
  const top = ranked[0][1];
  const winners = ranked.filter(([, s]) => s === top).map(([i]) => i);
  if (winners.length === 1) return { intent: winners[0], ambiguous: [] };
  return { intent: null, ambiguous: winners };
}

async function getDirectoryListings() {
  // Live and pilot listings only. Hidden rows exist in the table (seeded
  // ahead of market-readiness) and must never reach a caller.
  return sbGet(
    "dm_directory_listings",
    "select=id,slug,display_name,kind,intents,description,business_id,facts,gates,status,priority&status=in.(live,pilot)&order=priority.asc"
  );
}

function listingForAgent(l) {
  const out = {
    slug: l.slug,
    display_name: l.display_name,
    kind: l.kind,
    description: l.description || "",
    gates: l.gates || [],
  };
  if (l.kind === "business") {
    out.business_ref = l.slug;
    out.orderable = (l.gates || []).includes("order");
  } else {
    out.orderable = false;
    if (l.facts && l.facts.signup_url) out.signup_url = l.facts.signup_url;
  }
  return out;
}

async function handleLookupDirectory(args) {
  let listings;
  try {
    listings = await getDirectoryListings();
  } catch (e) {
    return json(500, { ok: false, error: "db_error", message: e.message });
  }
  const knownIntents = [...new Set(listings.flatMap((l) => l.intents || []))];

  let intent = args.intent || null;
  if (intent && !Object.prototype.hasOwnProperty.call(INTENT_LABELS, intent)) {
    intent = null; // unknown category string: fall through to query / clarify
  }
  if (!intent) {
    const query = args.query || args.need || args.message || "";
    if (!query) {
      // No intent and no words to classify: hand back the intent menu so
      // the agent asks ONE clarifying question, then calls again.
      return json(200, {
        ok: true,
        needs_intent: true,
        intents: knownIntents.map((k) => ({ intent: k, label: INTENT_LABELS[k] || k })),
        listings: [],
        rule: "Ask the caller one clarifying question to pin down their intent, then call lookup_directory again with that intent. Do not list businesses or services before the intent is known.",
      });
    }
    const { intent: classified, ambiguous } = classifyIntent(query);
    if (!classified) {
      if (ambiguous.length) {
        return json(200, {
          ok: true,
          needs_intent: true,
          ambiguous_intents: ambiguous.map((k) => ({ intent: k, label: INTENT_LABELS[k] || k })),
          listings: [],
          rule: "The caller's need could be more than one thing. Ask one clarifying question, then call lookup_directory with the chosen intent. Do not offer any listing yet.",
        });
      }
      return json(200, {
        ok: true,
        intent: null,
        listings: [],
        summary: "Nothing on the directory matches that yet.",
        rule: "Say plainly that we do not have that yet and offer to take a message. Never invent a business or service.",
      });
    }
    intent = classified;
  }

  const matches = listings.filter((l) => (l.intents || []).includes(intent)).map(listingForAgent);
  return json(200, {
    ok: true,
    intent,
    listings: matches,
    summary: matches.length
      ? matches.map((m) => `${m.name}: ${m.description}`).join(" ")
      : "Nothing live on the directory for that yet.",
    rule: "Offer ONLY these listings. Do not mention, hint at, or cross-suggest any other business or service. To work with one, call get_business_context with its slug.",
  });
}

function callIdFrom(args) {
  return args.call_id || (args.call && args.call.call_id) || null;
}

/* Mint + persist a voice context. The context_id is the enforcement token
 * for the concierge path: business-scoped tools presented with one are
 * rejected unless the context's business matches the call's business_ref.
 * The row also persists call_id -> listing for the call-sync webhook,
 * which tags dm_voice_calls with the listing served (billing split). */
async function mintContext({ callId, listingSlug, businessId }) {
  const contextId = crypto.randomUUID();
  try {
    await sbPostMinimal("dm_voice_contexts", {
      id: contextId,
      retell_call_id: callId || null,
      listing_slug: listingSlug,
      business_id: businessId || null,
    });
  } catch (e) {
    // Loud, not fatal: the call continues, but enforcement downstream can
    // only validate contexts that actually persisted.
    console.error("voice context persist failed:", e.message);
  }
  return contextId;
}

async function handleGetBusinessContext(args) {
  const ref = args.business_ref || args.slug || args.listing || "";
  if (!ref) {
    return json(400, { ok: false, error: "no_ref", message: "A listing slug (business_ref) is required." });
  }
  const callId = callIdFrom(args);
  let listings;
  try {
    listings = await getDirectoryListings();
  } catch (e) {
    return json(500, { ok: false, error: "db_error", message: e.message });
  }
  const listing = listings.find((l) => l.slug === ref);

  if (listing && listing.kind === "system") {
    const facts = listing.facts || {};
    const contextId = await mintContext({ callId, listingSlug: listing.slug, businessId: null });
    return json(200, {
      ok: true,
      context_id: contextId,
      listing: listing.slug,
      display_name: listing.display_name,
      kind: "system",
      orderable: false,
      description: listing.description || "",
      facts,
      gates: listing.gates || [],
      signup_url: facts.signup_url || null,
      summary: `${listing.display_name}: ${listing.description || ""}`,
      rule: "Info only. Answer questions from these facts. Do not take an order for this listing, and do not promise to text the signup link. Speak the link or take a message with take_message.",
    });
  }

  // Business listing (or a business slug with no listing yet): load the
  // live business row. Deliberately lean: menu and packages stay on-demand
  // through get_menu / get_packages with business_ref, same as the pilot
  // agent works. Facts like address and phone come from get_info.
  const businessId = listing && listing.business_id ? listing.business_id : null;
  let rows;
  try {
    const filter = businessId
      ? `id=eq.${encodeURIComponent(businessId)}`
      : `slug=eq.${encodeURIComponent(ref)}`;
    rows = await sbGet(
      "dm_businesses",
      `select=id,name,slug,phone_number,station_data,status&${filter}&status=eq.active&limit=1`
    );
  } catch (e) {
    return json(500, { ok: false, error: "db_error", message: e.message });
  }
  if (!rows || !rows.length) {
    return json(404, { ok: false, error: "listing_not_found", message: `No live listing or business for: ${ref}` });
  }
  const business = rows[0];
  const sd = business.station_data || {};
  const contextId = await mintContext({
    callId,
    listingSlug: listing ? listing.slug : business.slug,
    businessId: business.id,
  });
  return json(200, {
    ok: true,
    context_id: contextId,
    listing: listing ? listing.slug : business.slug,
    display_name: business.name,
    kind: "business",
    orderable: true,
    business_ref: business.slug,
    description: (listing && listing.description) || business.tagline || "",
    hours: sd.hours || "Hours not listed.",
    production_start: sd.production_start || null,
    timezone: sd.timezone || "America/Chicago",
    gates: listing ? listing.gates || [] : ["order", "info"],
    summary: `${business.name}: ${(listing && listing.description) || business.tagline || ""}`,
    rule: "You are now working as this business for the rest of the call. Pass this context_id and business_ref on every business tool call (get_menu, get_packages, create_package, place_order, get_delivery_fee). Do not bring up any other listing unless the caller asks to switch.",
  });
}

/* take_message: write a real row to dm_callback_requests. This is the
 * store behind every "we'll call you back" promise — the concierge's
 * fallback and the pilot agent's callback path both land here. It sends
 * NO text and makes NO promise beyond a person following up. */
async function handleTakeMessage(args) {
  const name = String(args.name || "").trim();
  const phone = normalizePhone(args.phone || args.caller_phone || "");
  const message = String(args.message || "").trim();
  const listingSlug = args.listing_slug || args.business_ref || null;
  const callId = callIdFrom(args);
  if (!message) {
    return json(400, { ok: false, error: "no_message", message: "A message is required." });
  }
  if (!phone) {
    return json(400, { ok: false, error: "no_phone", message: "A callback phone number is required to take a message." });
  }
  let businessId = null;
  if (listingSlug) {
    try {
      const listings = await getDirectoryListings();
      const l = listings.find((x) => x.slug === listingSlug);
      if (l && l.business_id) businessId = l.business_id;
    } catch (e) {
      console.error("take_message listing lookup failed:", e.message);
    }
  }
  try {
    const messageId = crypto.randomUUID();
    await sbPostMinimal("dm_callback_requests", {
      id: messageId,
      name: name || null,
      phone,
      message,
      listing_slug: listingSlug,
      business_id: businessId,
      retell_call_id: callId,
      source: args.source || "concierge",
    });
    return json(200, {
      ok: true,
      message_id: messageId,
      summary: `Message saved for ${name || "caller"} at ${phone}.`,
      rule: "Tell the caller a person will follow up. Do not promise a text or a specific callback time.",
    });
  } catch (e) {
    return json(500, { ok: false, error: "db_error", message: e.message });
  }
}

/* Context enforcement for business-scoped tools. Only applies when the
 * caller PRESENTS a context_id (the concierge path). No context_id means
 * the pinned per-shop agent path, which is unaffected. A presented
 * context must exist, must belong to the resolved business, and — when
 * both sides carry a call_id — must belong to this call. System contexts
 * (business_id null) can never authorize a business tool. */
async function validateContext(contextId, business, args) {
  const rows = await sbGet(
    "dm_voice_contexts",
    `select=id,retell_call_id,listing_slug,business_id&id=eq.${encodeURIComponent(contextId)}&limit=1`
  );
  if (!rows || !rows.length) return "context_not_found";
  const ctx = rows[0];
  if (!ctx.business_id || ctx.business_id !== business.id) return "context_business_mismatch";
  const callId = callIdFrom(args);
  if (callId && ctx.retell_call_id && ctx.retell_call_id !== callId) return "context_call_mismatch";
  return null;
}

exports.handler = async (event) => {
  const secret = event.headers["x-retell-secret"] || event.headers["X-Retell-Secret"];
  if (RETELL_SECRET && secret !== RETELL_SECRET) {
    return json(401, { ok: false, error: "bad_secret" });
  }

  if (!SUPABASE_SERVICE_KEY) {
    return json(500, { ok: false, error: "no_database" });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "bad_json" });
  }

  const action = body.action || body.function_name || (body.name || "").replace(/^station_/, "");
  const args = body.args || body.arguments || body.parameters || {};
  const merged = { ...body, ...args };

  // Concierge directory actions run BEFORE business resolution: the whole
  // point is that the caller has not picked a business yet. They must never
  // fall through to the default-business fallback below.
  if (action === "lookup_directory" || action === "list_directory" || action === "search_directory") {
    return handleLookupDirectory({ ...merged, intent: merged.intent || null });
  }
  if (action === "get_business_context") {
    return handleGetBusinessContext(merged);
  }
  if (action === "take_message") {
    return handleTakeMessage(merged);
  }

  let business;
  try {
    business = await resolveBusiness(merged);
  } catch (e) {
    return json(500, { ok: false, error: "db_error", message: e.message });
  }
  if (!business) {
    return json(404, { ok: false, error: "business_not_found" });
  }

  // Concierge context enforcement: only when the caller presents a
  // context_id. The pinned per-shop agent never does, so it is unaffected.
  const presentedContext = merged.context_id || args.context_id || null;
  if (presentedContext) {
    let ctxError = null;
    try {
      ctxError = await validateContext(presentedContext, business, merged);
    } catch (e) {
      ctxError = "context_check_failed";
      console.error("context validation error:", e.message);
    }
    if (ctxError) {
      return json(403, {
        ok: false,
        error: "context_mismatch",
        message: `This call's context does not cover ${business.name}. Load the right listing with get_business_context first. (${ctxError})`,
      });
    }
  }

  try {
    switch (action) {
      case "get_menu": {
        const menu = formatMenu(business);
        return json(200, {
          ok: true,
          business: business.name,
          items: menu,
          summary: menu.map((i) => `${i.name} (${i.price_display})`).join(", "),
        });
      }

      case "get_packages": {
        const packages = await getPackages(business.id);
        return json(200, {
          ok: true,
          business: business.name,
          packages,
          summary: packages.length
            ? packages.map((p) => `${p.name} (${p.price_display})`).join(", ")
            : "No packages currently listed.",
        });
      }

      case "get_hours": {
        const hours = (business.station_data && business.station_data.hours) || "Hours not listed.";
        return json(200, {
          ok: true,
          business: business.name,
          hours: hours,
        });
      }

      case "get_info": {
        const sd = business.station_data || {};
        return json(200, {
          ok: true,
          business: business.name,
          address: sd.address || "Address not listed.",
          phone: business.phone_number || "Phone not listed.",
          hours: sd.hours || "Hours not listed.",
        });
      }

      case "place_order": {
        const items = args.items || merged.items || [];
        if (!items.length) {
          return json(400, { ok: false, error: "no_items", message: "No items specified for order." });
        }

        const fulfillment = args.fulfillment || merged.fulfillment || "pickup";
        const deliveryAddress = args.delivery_address || merged.delivery_address || null;

        // Calculate delivery fee: $35 through 3 dozen, $4 per dozen above
        let deliveryFeeCents = 0;
        if (fulfillment === "delivery") {
          if (!deliveryAddress) {
            return json(400, { ok: false, error: "no_address", message: "Delivery address is required for delivery orders." });
          }
          // Estimate dozens from items (rough: assume 12 units per dozen)
          let totalUnits = 0;
          for (const it of items) {
            totalUnits += parseInt(it.quantity || it.qty || 1, 10);
          }
          const dozens = Math.ceil(totalUnits / 12);
          const feeDollars = dozens <= 3 ? 35 : 35 + (dozens - 3) * 4;
          deliveryFeeCents = feeDollars * 100;
        }

        // Server-side total: deterministic pricing, never trust the model for
        // money. Resolution order:
        //   1. package_id lookup (already priced with premium + markup baked in)
        //   2. item-by-item: match package names first (priced already), then
        //      menu items (shop price + 10% custom premium + 15% DayMarket markup)
        //   3. model's total_cents as last resort
        let totalCents = parseInt(args.total_cents || merged.total_cents || 0, 10);
        const packageId = args.package_id || merged.package_id || null;
        let packageName = null;
        if ((!totalCents || totalCents <= 0) && packageId) {
          try {
            const pkgs = await sbGet(
              "dm_packages",
              `select=id,name,base_price_cents&id=eq.${encodeURIComponent(packageId)}&limit=1`
            );
            if (pkgs && pkgs.length && pkgs[0].base_price_cents != null) {
              totalCents = pkgs[0].base_price_cents;
              packageName = pkgs[0].name;
            }
          } catch (e) {
            console.error("package price lookup failed:", e.message);
          }
        }
        if (!totalCents || totalCents <= 0) {
          // Item-by-item server-side pricing.
          try {
            const menuByName = {};
            for (const m of (business.station_data?.menu_items || [])) {
              if (m.name) menuByName[String(m.name).toLowerCase()] = m;
            }
            const pkgsByName = {};
            try {
              const pkgs = await sbGet(
                "dm_packages",
                `select=id,name,base_price_cents&business_id=eq.${encodeURIComponent(business.id)}&active=eq.true&order=created_at.desc&limit=200`
              );
              for (const p of (pkgs || [])) {
                const k = String(p.name || "").toLowerCase();
                if (k && !(k in pkgsByName)) pkgsByName[k] = p;
              }
            } catch (e) {
              console.error("package list lookup failed:", e.message);
            }
            let priced = 0;
            for (const it of items) {
              const name = String(it.name || "").toLowerCase();
              const qty = parseInt(it.quantity || it.qty || 1, 10) || 1;
              if (!name) continue;
              const pkg = pkgsByName[name];
              if (pkg && pkg.base_price_cents != null) {
                // Packages are already priced (premium + markup baked in).
                totalCents += parseInt(pkg.base_price_cents, 10) * qty;
                priced += qty;
                continue;
              }
              const menuItem = menuByName[name];
              if (menuItem && menuItem.price_cents != null) {
                // Menu price is the shop's shelf price: stack 10% custom
                // premium + 15% DayMarket markup on top, same as create_package.
                const base = parseInt(menuItem.price_cents, 10) * qty;
                const shopPrice = base + Math.round(base * 0.10);
                const withMarkup = shopPrice + Math.round(shopPrice * 0.15);
                totalCents += withMarkup;
                priced += qty;
              } else {
                console.error("place_order: unpriced item, no link for it:", it.name);
              }
            }
            if (priced > 0) console.log("place_order: server-side item total", totalCents, "cents");
          } catch (e) {
            console.error("item pricing failed:", e.message);
          }
        }

        const order = await sbPost("dm_orders", {
          business_id: business.id,
          package_id: packageId,
          title: `Voice order - ${packageName || business.name}`,
          scheduled_for: new Date().toISOString(),
          items: items,
          total_cents: totalCents > 0 ? totalCents : null,
          status: "pending_review",
          channel: "voice",
          caller_phone: normalizePhone(args.caller_phone || merged.caller_phone || ""),
          notes: (args.notes || merged.notes || "Voice order via Retell") +
            (fulfillment === "delivery" ? ` [DELIVERY] Address: ${deliveryAddress}. Fee: $${(deliveryFeeCents / 100).toFixed(2)}.` : " [PICKUP]"),
          fulfillment: fulfillment,
          delivery_address: deliveryAddress,
          delivery_fee_cents: deliveryFeeCents,
        });

        // Payment links. Two separate charges by design:
        //   Link 1 (order): the food total. Paid to DayMarket or straight through
        //     the business — whichever the merchant arrangement is.
        //   Link 2 (delivery): DayMarket Delivery's fee, due right away at booking,
        //     independent of how the food is paid. A delivery always generates its
        //     own link even when the order itself is paid elsewhere (e.g. the shop
        //     directly). Pickup generates no delivery link at all.
        // Calculate order total for Stripe.
        let paymentUrl = null;
        let stripeSessionId = null;
        let deliveryPaymentUrl = null;
        let deliveryStripeSessionId = null;
        let smsSent = false;

        // Payment links are skipped entirely for demo businesses
        // (station_data.demo) so demo orders never touch live Stripe.
        if (process.env.STRIPE_SECRET_KEY && !(business.station_data && business.station_data.demo)) {
          // Link 1: the order.
          if (totalCents > 0) {
            try {
              const session = await createCheckoutSession({
                amount_cents: totalCents,
                order_id: order.id,
                business_name: business.name,
                customer_phone: normalizePhone(args.caller_phone || merged.caller_phone || ""),
                description: `Order from ${business.name} (${fulfillment})`,
              });
              paymentUrl = session.url;
              stripeSessionId = session.id;
              await sbPatch("dm_orders", order.id, {
                payment_url: paymentUrl,
                stripe_session_id: stripeSessionId,
              });
            } catch (e) {
              console.error("Stripe order checkout failed:", e.message);
            }
          }
          // Link 2: the delivery fee. Always its own session so the delivery
          // money is separable and due immediately, whatever happens with the food.
          if (fulfillment === "delivery" && deliveryFeeCents > 0) {
            try {
              const dSession = await createCheckoutSession({
                amount_cents: deliveryFeeCents,
                order_id: order.id,
                business_name: "DayMarket Delivery",
                customer_phone: normalizePhone(args.caller_phone || merged.caller_phone || ""),
                description: `DayMarket Delivery fee (${business.name} order)`,
              });
              deliveryPaymentUrl = dSession.url;
              deliveryStripeSessionId = dSession.id;
              await sbPatch("dm_orders", order.id, {
                delivery_payment_url: deliveryPaymentUrl,
                delivery_stripe_session_id: deliveryStripeSessionId,
              });
            } catch (e) {
              console.error("Stripe delivery checkout failed:", e.message);
            }
          }

          // Text the link(s). One SMS carrying whichever links exist.
          if (paymentUrl || deliveryPaymentUrl) {
            try {
              const smsTo = normalizePhone(args.caller_phone || merged.caller_phone || "");
              let smsBody = `${business.name} order confirmed.`;
              if (paymentUrl) smsBody += ` Pay order: ${paymentUrl}`;
              if (deliveryPaymentUrl) smsBody += ` Pay delivery ($${(deliveryFeeCents / 100).toFixed(2)}): ${deliveryPaymentUrl}`;
              smsBody += ` DayMarket.`;
              const sms = await sendSms(smsTo, smsBody);
              if (sms.ok) { console.log("SMS payment link(s) sent", order.id, sms.sid); smsSent = true; }
              else console.error("SMS payment link skipped/failed", order.id, sms.skipped || sms.error);
            } catch (e) {
              console.error("SMS payment link error", order.id, e.message);
            }
          }
        }

        const linksSentNote = paymentUrl && deliveryPaymentUrl && smsSent
          ? " Order and delivery links sent."
          : paymentUrl && smsSent
            ? " Payment link sent."
            : deliveryPaymentUrl && smsSent
              ? " Delivery link sent."
              : "";

        // Gatekeeper loop: stamp fulfillment timing, mint a confirm token, and
        // text the humans over the gate. Never breaks the order on failure.
        let fulfillmentType = "asap";
        try {
          const confirmToken = crypto.randomBytes(32).toString("hex");
          fulfillmentType = fulfillmentTypeFor(business);
          await sbPatch("dm_orders", order.id, {
            fulfillment_type: fulfillmentType,
            confirm_token: confirmToken,
          });
          await notifyGatekeepers({
            business,
            order,
            items,
            totalCents,
            fulfillment,
            fType: fulfillmentType,
            confirmToken,
            callerPhone: normalizePhone(args.caller_phone || merged.caller_phone || ""),
          });
        } catch (e) {
          console.error("gatekeeper loop failed:", e.message);
        }

        return json(200, {
          ok: true,
          order_id: order.id,
          fulfillment: fulfillment,
          fulfillment_type: fulfillmentType,
          delivery_fee: (deliveryFeeCents / 100).toFixed(2),
          payment_url: paymentUrl,
          delivery_payment_url: deliveryPaymentUrl,
          message: fulfillment === "delivery"
            ? `Order received for delivery. Delivery fee is $${(deliveryFeeCents / 100).toFixed(2)}.${linksSentNote}`
            : `Order received for pickup.${linksSentNote}`,
        });
      }

      case "get_delivery_fee": {
        // Calculate delivery fee for a given quantity
        const dozens = parseInt(args.dozens || merged.dozens || 1, 10);
        const feeDollars = dozens <= 3 ? 35 : 35 + (dozens - 3) * 4;
        return json(200, {
          ok: true,
          dozens: dozens,
          fee: feeDollars.toFixed(2),
          fee_display: `$${feeDollars.toFixed(2)}`,
          message: `Delivery fee for ${dozens} dozen is $${feeDollars.toFixed(2)}.`,
        });
      }

      case "book_delivery": {
        // Delivery-only booking: business books DayMarket delivery for their own customer.
        // Customer pays just the delivery fee via Stripe. Business handles the food/order separately.
        const customerPhone = normalizePhone(args.customer_phone || merged.customer_phone || "");
        const deliveryAddress = args.delivery_address || merged.delivery_address || "";
        const dozens = parseInt(args.dozens || merged.dozens || 1, 10);
        const businessContact = args.business_contact || merged.business_contact || "";

        if (!customerPhone) {
          return json(400, { ok: false, error: "no_customer_phone", message: "Customer phone number is required to send the payment link." });
        }
        if (!deliveryAddress) {
          return json(400, { ok: false, error: "no_address", message: "Delivery address is required." });
        }

        const feeDollars = dozens <= 3 ? 35 : 35 + (dozens - 3) * 4;
        const feeCents = feeDollars * 100;

        // Create delivery record
        const delivery = await sbPost("dm_orders", {
          business_id: business.id,
          items: [{ name: "Delivery service", quantity: 1, dozens: dozens }],
          status: "delivery_booked",
          channel: "voice",
          caller_phone: customerPhone,
          fulfillment: "delivery",
          delivery_address: deliveryAddress,
          delivery_fee_cents: feeCents,
          notes: `Delivery-only booking via ${business.name}. Booked by: ${businessContact || "business"}. ${dozens} dozen. Customer pays delivery fee.`,
        });

        // Create Stripe checkout for delivery fee (skipped for demo businesses)
        let paymentUrl = null;
        let stripeSessionId = null;
        if (process.env.STRIPE_SECRET_KEY && !(business.station_data && business.station_data.demo)) {
          try {
            const session = await createCheckoutSession({
              amount_cents: feeCents,
              order_id: delivery.id,
              business_name: business.name,
              customer_phone: customerPhone,
              description: `Delivery from ${business.name} (${dozens} dozen)`,
            });
            paymentUrl = session.url;
            stripeSessionId = session.id;
            await sbPatch("dm_orders", delivery.id, {
              delivery_payment_url: paymentUrl,
              delivery_stripe_session_id: stripeSessionId,
            });
            try {
              const sms = await sendSms(
                customerPhone,
                `Delivery from ${business.name} booked. Pay the $${feeDollars.toFixed(2)} fee here: ${paymentUrl} DayMarket.`
              );
              if (sms.ok) console.log("SMS delivery link sent", delivery.id, sms.sid);
              else console.error("SMS delivery link skipped/failed", delivery.id, sms.skipped || sms.error);
            } catch (e) {
              console.error("SMS delivery link error", delivery.id, e.message);
            }
          } catch (e) {
            console.error("Stripe checkout failed for delivery:", e.message);
          }
        }

        return json(200, {
          ok: true,
          delivery_id: delivery.id,
          fee: feeDollars.toFixed(2),
          fee_display: `$${feeDollars.toFixed(2)}`,
          payment_url: paymentUrl,
          customer_phone: customerPhone,
          message: paymentUrl
            ? `Delivery booked. Fee is $${feeDollars.toFixed(2)}. Payment link ready to send to customer.`
            : `Delivery booked. Fee is $${feeDollars.toFixed(2)}. Payment link not yet generated.`,
        });
      }

      case "create_package": {
        // Build a custom package from menu items with 10% premium
        const items = args.items || merged.items || [];
        if (!items.length) {
          return json(400, { ok: false, error: "no_items", message: "No items specified for package." });
        }

        const menu = formatMenu(business);
        const menuByName = {};
        for (const m of (business.station_data?.menu_items || [])) {
          menuByName[m.name.toLowerCase()] = m;
        }

        let baseCents = 0;
        const cleanItems = [];
        for (const it of items) {
          const menuItem = menuByName[String(it.name || "").toLowerCase()];
          if (!menuItem || menuItem.price_cents == null) continue;
          const qty = parseInt(it.quantity || it.qty || 1, 10);
          // If they said "dozen", convert to units (menu prices are per item)
          const isDozen = /dozen/i.test(it.unit || "") || qty >= 12;
          const units = isDozen && qty < 12 ? qty * 12 : qty;
          const lineTotal = units * menuItem.price_cents;
          baseCents += lineTotal;
          cleanItems.push({
            name: menuItem.name,
            qty: units,
            unit_price_cents: menuItem.price_cents,
          });
        }

        if (!baseCents || !cleanItems.length) {
          return json(400, { ok: false, error: "no_valid_items", message: "Could not match items to the menu." });
        }

        const premiumCents = Math.round(baseCents * 0.10);
        const shopPriceCents = baseCents + premiumCents;
        // DayMarket adds 15% on top. Shop nets the full shop price.
        const markupCents = Math.round(shopPriceCents * 0.15);
        const priceCents = shopPriceCents + markupCents;
        const itemList = cleanItems.map((i) => `${i.qty}x ${i.name}`).join(", ");
        const packageName = args.name || merged.name || `Custom Package`;

        const pkg = await sbPost("dm_packages", {
          business_id: business.id,
          name: packageName,
          description: `Custom bundle: ${itemList}. Built via phone.`,
          base_price_cents: priceCents,
          is_custom: true,
          active: true,
        });

        return json(200, {
          ok: true,
          package_id: pkg.id,
          package_name: packageName,
          price: (priceCents / 100).toFixed(2),
          price_display: `$${(priceCents / 100).toFixed(2)}`,
          shop_price: (shopPriceCents / 100).toFixed(2),
          items: itemList,
          message: `Created ${packageName} for $${(priceCents / 100).toFixed(2)}.`,
        });
      }

      default:
        return json(400, {
          ok: false,
          error: "unknown_action",
          message: `Unknown action: ${action}. Available: lookup_directory, get_business_context, take_message, get_menu, get_packages, get_hours, get_info, place_order, create_package, get_delivery_fee, book_delivery.`,
        });
    }
  } catch (e) {
    return json(500, { ok: false, error: "action_failed", message: e.message });
  }
};
