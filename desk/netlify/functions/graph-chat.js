// graph-chat.js — OpOne Capital Desk: Instruction Layer v2.
// The brain (knowledge graph + this code) gives the orders. Groq is the
// substrate: a voice, not a mind. The model originates nothing and connects
// everything. The rules live in deterministic code, never only in a prompt.
//
// Merryhill Protocol mapping (see ~/memory/merryhill-protocol.md):
// Axiom I, Separation of Intelligence and Logic, is the layer itself: the
// model is a replaceable engine, the governance in this file is permanent.
// Change the model; the governance remains intact.
// Axiom IV, the Recursive Audit Loop ("if it was attempted, it is in the
// record, the loop never opens"): the audit law below logs the whole
// attempt — the question, the context handed to the model, the raw answer
// before validation, every failure with the rule that failed, the repair
// attempt and its result, and the answer actually served — plus drift
// monitoring over those records. The protocol's drift layer list is what
// the monitor watches for: conflicting guidance, bad datasets, outdated
// models, hallucinations, misinformation (and the rest of the list in the
// protocol: inconsistent estimates, manipulated reporting, politicized
// interpretation).
// Axiom V, the Human-Centric Kill Switch: no execution at L3/L4 without
// Milly's explicit authorization on record, enforced in code, not as a UI
// button. The layer classifies every attempt by irreversibility level in
// code and alerts on any L3/L4 attempt, passed or blocked. The layer never
// authorizes an L3/L4 action; it only classifies and alerts. Milly's word
// is the gate. (The protocol notes the L-level is a human judgment about
// consequence; the layer's code classification is by what was attempted,
// and the human owns the authorization.)
//
// Two callers, one gate (shared module, not a panel-only feature):
// the Desk Ask panel and Bobby the agent. Both POST to this function with
// the same contract. Bobby acts for Milly, so Bobby's calls use owner
// scope and caller "bobby". Any future agent answering a member calls the
// same layer with member scope. The layer is the single place that decides
// what any agent may see.
//
// Two modes, picked in code, never by the model:
// record — the question names an asset, ticker, position, price, or the
// firm's book. Strict. No graph context means no model call at all.
// teach — how / what-is / explain questions. For Milly (owner scope) with
// context, the lesson uses his own book as the textbook: real fills, real
// stops, real targets, real LEAPS, cited. General knowledge stays labeled
// as general knowledge and never supplies numbers about the book. For a
// member, teach is general knowledge only, and the firm's book never
// enters.
// Scoping is per asker: owner scope is the FULL firm book. Milly must be
// able to see the books through the layer. Member scope is only that
// member's own book, never the firm's. The layer enforces it by who is
// asking, not by hiding the book from everyone.
// The model never acts: no tools, no function calling, no write path to
// the graph, the ledger, or any account. One constant for the model, one
// env var for the key.
//
// Actions (body.action): "ask" (default), "validate" (draft validation,
// no model call), "compare" (a web finding against the graph: confirm,
// contradict, or extend; a contradiction is flagged, never silently
// overwritten; new facts come back as candidate intake, never as asserted
// truth, and the layer never writes to the graph).
//
// STAGED Nov 6, 2026. GROQ_API_KEY went live Nov 7, 2026. Instruction
// Layer v1 shipped Nov 7, 2026. v2 (owner/member scoping, teach with the
// book, agent uses, audit law, drift monitoring, attempt alerts) built
// Nov 7, 2026.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
// Groq returns no separate model version; the versioned model id is the
// version recorded in the audit log.
const GROQ_MODEL_VERSION = GROQ_MODEL;

// Narrow this to the Desk origin when the subdomain is live.
const ALLOWED_ORIGIN = "https://opone.tabronmerryhill.com";

const TICKERS = [
"MU", "QCOM", "GLD", "AMD", "DUOL", "NVDA", "DIA", "SPY", "ANET", "APP",
"IREN", "AVGO", "MRVL", "GOOGL", "BRK.B", "VST", "FRO", "BE", "BTC", "ETH",
];

const RECORD_WORDS = /\b(position|portfolio|book|fill|stop|target|kill|thesis|price|trade|pnl|p&l|cash|equity|holdings|bought|sold|shares|contract|premium)\b/i;
const TEACH_START = /^(what is|what are|what does|explain|define|describe|how does|how do|why does)\b/i;
// Case-sensitive on purpose: the ticker BE must only match uppercase BE,
// or the English word "be" trips every check that uses this pattern.
const TICKER_RE = new RegExp("\\b(" + TICKERS.map(function (t) { return t.replace(".", "\\.");}).join("|") + ")\\b");

// ---- Drift thresholds, versioned in code (Axiom IV recursion) ----
// A change to these thresholds is itself visible: the version is logged
// with every drift run, so the monitor's own history is in the record.
const DRIFT_THRESHOLDS_VERSION = 1;
const DRIFT_THRESHOLDS = {
minCalls: 10, // rates mean nothing on fewer calls; below this, no flag
maxFailureRate: 0.25, // first-attempt validation failures / model calls
maxRepairRate: 0.40, // repair attempts / model calls
};

// In-process ring buffer of audit records for drift math. Best effort:
// Netlify functions are stateless, so the durable drift store is the
// audit log itself; the daily routine recomputes these rates from it.
var auditBuffer = [];
const AUDIT_BUFFER_MAX = 200;
var swapLogged = {};

const SYSTEM_PROMPT_RECORD = [
"You are the voice of OpOne Capital's knowledge graph.",
"The graph is the firm's memory and brain. You speak for it, nothing else.",
"Answer only from the graph context given in this request.",
"Cite every claim with the node or edge id it came from, like [asset:MU] or [news:2026-11-06-payrolls].",
"If the graph does not record it, say so plainly and do not guess.",
"A signal scorecard is not a trade. A pattern is not an edge.",
"News precedes a price move. Never say news caused it.",
"Never recommend a trade without stating its kill criterion.",
"Never place a trade. Never invent a price, a fill, or a balance.",
"Short plain sentences. No em dashes.",
].join(" ");

const SYSTEM_PROMPT_TEACH = [
"You are teaching a concept in plain words.",
"This is general knowledge, not the firm's record.",
"Explain the idea and how it works. Use a small example with round numbers if it helps.",
"Never state a price, fill, position, or book figure for any firm asset.",
"Never name a firm ticker. Never recommend a trade.",
"If asked about the firm's numbers, say the graph does not record it.",
"Short plain sentences. No em dashes.",
].join(" ");

// Teach mode for Milly (owner scope, with context): his own book is the
// textbook. Real examples from his records, cited; general knowledge
// labeled in-line; every figure from the records, never invented.
const SYSTEM_PROMPT_TEACH_WITH_BOOK = [
"You are teaching a concept to the owner, using his own book as the textbook.",
"Explain the idea in plain words, then show it with real examples from the owner's records below: real fills, real stops, real targets, real LEAPS.",
"Cite every book example with its graph id, like [trade:2026-11-06-8].",
"Label general statements 'General knowledge:' in-line.",
"Use ONLY the numbers in the records below for every figure, including examples.",
"Never state a number about the book that is not in the records.",
"Never recommend a trade without stating its kill criterion.",
"Never place a trade. Never invent a price, a fill, or a balance.",
"Short plain sentences. No em dashes.",
].join(" ");

// Compare action: a web finding against the graph. The verdict word comes
// first so the layer can read it in code. A contradiction is flagged,
// never silently overwritten.
const SYSTEM_PROMPT_COMPARE = [
"You are comparing a web finding to the OpOne Capital knowledge graph.",
"Answer with a verdict word first: CONFIRM, CONTRADICT, or EXTEND.",
"CONFIRM means the graph already records the same fact. CONTRADICT means the graph records something different. EXTEND means the finding is new to the graph.",
"Cite every graph claim with its node or edge id, like [asset:MU].",
"Label claims that come from the finding itself as 'from the finding'.",
"Never state a graph number that is not in the context below.",
"Never recommend a trade without stating its kill criterion.",
"Never place a trade. Short plain sentences. No em dashes.",
].join(" ");

const PLAIN_NOT_RECORDED = "The graph does not record it.";
const PLAIN_CANNOT_ANSWER = "The graph does not record that in a way I can answer from.";

// ---- Mode: picked in code, never by the model ----
function detectMode(question) {
var q = question.trim();
if (TICKER_RE.test(q)) return "record";
if (TEACH_START.test(q)) return "teach";
if (RECORD_WORDS.test(q)) return "record";
return "record"; // strict default: an unclear question gets the strict path
}

// ---- Scope: per asker, enforced by the layer ----
// Owner scope is the FULL firm book. Member scope is only that member's
// own book, never the firm's. "firm" is the legacy alias for "owner"
// (the Desk panel used to send it). Anything unknown resolves to owner:
// the Desk is an owner surface; a member surface must pass an explicit
// member scope, and the layer never upgrades a member scope to owner.
function resolveScope(scope) {
var s = typeof scope === "string"? scope.trim(): "";
if (s === "owner" || s === "firm" || s === "") return "owner";
if (s.indexOf("member:") === 0 && s.length > 7) return s;
return "owner";
}

function scopeContext(rawContext, askerScope) {
var s = resolveScope(askerScope);
return (Array.isArray(rawContext)? rawContext: []).filter(function (c) {
if (!c || typeof c.id!== "string") return false;
var cs = typeof c.scope === "string"? c.scope: "firm";
if (s === "owner") return cs === "firm" || cs === "owner";
return cs === s;
});
}

function normalizeContext(rawContext) {
return rawContext.slice(0, 40).map(function (c) {
return {
id: c.id,
type: typeof c.type === "string"? c.type: "",
label: typeof c.label === "string"? c.label: "",
evidence: typeof c.evidence === "string"? c.evidence.slice(0, 500): "",
scope: typeof c.scope === "string"? c.scope: "firm",
};
});
}

function contextTextOf(context) {
return context.map(function (c) {
return c.id + " (" + c.type + ") " + c.label + (c.evidence? " -- " + c.evidence: "");
}).join("\n");
}

// ---- Numbers: in the context, or derivable from it ----
function extractNumbers(text) {
var clean = String(text || "").replace(/【[a-z_]+:[^】]+】/g, " ").replace(/\[[a-z_]+:[^\]]+\]/g, " ");
var out = [];
var re = /\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*%?/g;
var m;
while ((m = re.exec(clean))!== null) out.push(parseFloat(m[1].replace(/,/g, "")));
return out;
}

function buildAllowedNumbers(contextNumbers, questionNumbers) {
var base = (contextNumbers || []).concat(questionNumbers || []).slice(0, 200);
var set = {};
function add(v) {
if (typeof v === "number" && isFinite(v)) set[v] = true;
}
var i, j, a, b;
for (i = 0; i < base.length; i++) add(base[i]);
for (i = 0; i < base.length; i++) {
a = base[i];
add(a * 100);
add(a / 100);
for (j = 0; j < base.length; j++) {
b = base[j];
// No plain sums: with enough base numbers, a+b manufactures almost any
// round number (600 + 100 = 700) and the check goes toothless. Kept:
// differences between levels, fractional quantity x price, ratios, and
// percent change. Those are the derivations the desk actually uses.
add(a - b);
if (Math.min(Math.abs(a), Math.abs(b)) < 1) add(a * b);
if (b!== 0) add(a / b);
if (b!== 0) add(((a - b) / b) * 100);
}
}
var arr = Object.keys(set).map(Number).sort(function (x, y) { return x - y;});
return arr;
}

function numberAllowed(v, sortedAllowed) {
if (Number.isInteger(v) && v >= 0 && v <= 10) return true; // counts
if (Number.isInteger(v) && v >= 2000 && v <= 2100) return true; // years
var tol = Math.max(0.02, 0.001 * Math.abs(v));
var lo = 0, hi = sortedAllowed.length - 1, mid;
while (lo <= hi) {
mid = (lo + hi) >> 1;
if (Math.abs(sortedAllowed[mid] - v) <= tol) return true;
if (sortedAllowed[mid] < v) lo = mid + 1;
else hi = mid - 1;
}
if (lo < sortedAllowed.length && Math.abs(sortedAllowed[lo] - v) <= tol) return true;
if (hi >= 0 && Math.abs(sortedAllowed[hi] - v) <= tol) return true;
return false;
}

// ---- Citations: both bracket forms count ----
function extractCitations(answer) {
var found = (String(answer || "").match(/【[a-z_]+:[^】]+】/g) || []).concat(String(answer || "").match(/\[[a-z_]+:[^\]]+\]/g) || []);
var ids = {};
found.forEach(function (m) { ids[m.slice(1, -1)] = true;});
return Object.keys(ids);
}

// Tickers named in a text, as written. Used to check that an answer only
// names assets the record (or the question) already names.
function tickersNamed(text) {
var re = new RegExp(TICKER_RE.source, "g");
var out = [];
var m;
while ((m = re.exec(String(text || "")))!== null) {
if (out.indexOf(m[1]) < 0) out.push(m[1]);
}
return out;
}

// ---- Trade talk: a recommendation, not a definition ----
// "A call is the right to buy 100 shares" defines the instrument; "Buy MU
// now" recommends a trade. The detector flags directives and named-asset
// actions only, so a teaching answer can define an option without tripping
// it. "You can buy" is instructional, not a call, and is left alone.
function hasTradeTalk(answer) {
var sentences = String(answer || "").split(/(?<=[.!?])\s+/);
for (var i = 0; i < sentences.length; i++) {
var s = sentences[i];
if (/\b(go long|go short|long the|short the)\b/i.test(s) && TICKER_RE.test(s)) return true;
if (/\b(buy|sell|enter|take|open)\b(?!-)/i.test(s) && TICKER_RE.test(s)) return true;
if (/^\s*(buy|sell|open|take|enter)\b(?!-)/i.test(s)) return true;
if (/\byou should\s+(buy|sell|open|take|enter|go)\b(?!-)/i.test(s)) return true;
}
return false;
}

// ---- Validation: deterministic, before the answer is served ----
// scope defaults to owner (the Desk is an owner surface). extraAllowed
// numbers are supplied evidence that is not the graph: for the compare
// action, the finding's own numbers.
// Teach-with-book (teach mode, owner scope, context present) validates
// like record mode: every number from the record, citations resolve, trade
// talk needs a kill in the context, and any ticker named must be one the
// record or the question already names. Pure teach (no context, or member
// scope) bars firm tickers outright and rejects trade talk outright.
function validateAnswer(answer, context, mode, question, scope, extraAllowedNumbers) {
var violations = [];
var contextIds = context.map(function (c) { return c.id;});
var contextText = contextTextOf(context);
var s = resolveScope(scope);
var teachWithBook = mode === "teach" && s === "owner" && context.length > 0;

var cites = extractCitations(answer);
cites.forEach(function (id) {
if (contextIds.indexOf(id) < 0) violations.push("citation " + id + " does not resolve to a context item");
});
// A record answer (or a lesson from the book) that makes claims from the
// record but cites nothing has not done its job: cite or say you don't
// know. A plain refusal ("the graph does not record it") is exempt.
if ((mode === "record" || teachWithBook) && cites.length === 0 && !/does not record/i.test(answer)) {
violations.push("answer cites no context id");
}

if (hasTradeTalk(answer)) {
if (mode === "record" || teachWithBook) {
if (!/kill/i.test(contextText)) violations.push("trade talk without a kill criterion in the context");
} else {
violations.push("trade talk is not allowed in a teaching answer: remove the recommendation, do not add a kill criterion");
}
}

if (mode === "record" || teachWithBook) {
var ctxNums = [];
context.forEach(function (c) {
ctxNums = ctxNums.concat(extractNumbers(c.label + " " + c.evidence));
});
var allowed = buildAllowedNumbers(ctxNums, extractNumbers(question).concat(extraAllowedNumbers || []));
extractNumbers(answer).forEach(function (n) {
if (!numberAllowed(n, allowed)) violations.push("number " + n + " is not in the context and cannot be derived from it");
});
// An answer may only name assets the record or the question already
// names. A refusal that echoes the question's ticker is fine.
var named = tickersNamed(answer);
var allowedTickers = tickersNamed(contextText).concat(tickersNamed(question));
named.forEach(function (t) {
if (allowedTickers.indexOf(t) < 0) violations.push("ticker " + t + " is not in the context or the question");
});
} else {
if (TICKER_RE.test(answer)) violations.push("teaching answer names a firm asset");
}

return { passed: violations.length === 0, violations: violations};
}

// ---- Attempt level: L1-L4, assigned in code from what was attempted ----
// Axiom V. The level is the irreversibility of the attempt, never the
// model's say-so. L1 reversible/advisory, L2 internal commitment, L3
// external/binding, L4 irreversible/structural. The layer classifies and
// alerts; it never authorizes an L3/L4 action. Milly's word is the gate.
function classifyAttemptLevel(question, answer, mode) {
var q = String(question || "");
var a = String(answer || "");
var text = q + "\n" + a;
var reason = "advisory answer, no commitment";
var level = 1;
if (/\b(delete|deleted|drop|dropped|remove|removed|rewrite|rewrote|overwrite|overwrote)\b.{0,40}\b(graph|ledger|record|rule|threshold|kill switch)\b/i.test(text)
|| /\b(change|edit|update)\b.{0,30}\b(the)?(rule|threshold|kill switch)\b/i.test(text)
|| /\bwrite to the (graph|ledger)\b/i.test(text)
|| /\b(deleted|rewrote|overwrote) the (graph|ledger|record)\b/i.test(a)) {
level = 4;
reason = "attempt to change or delete the record, the rules, or the ledger";
} else if (/\b(place|execute|submit|file|cancel)\b.{0,30}\b(order|trade)\b/i.test(text)
|| /\b(send|publish|post|email)\b.{0,30}\b(the)?(order|post|email|message|brief|article)\b/i.test(text)) {
level = 3;
reason = "attempt to execute an order or send something externally";
} else if (hasTradeTalk(a) || hasTradeTalk(q)) {
level = 2;
reason = "trade recommendation, an internal commitment to a direction";
}
return { level: level, reason: reason};
}

// ---- Drift monitoring (Axiom IV recursion) ----
// Rates are computed from the audit log in deterministic code, never by
// asking the model. Per model: validation failure rate (first-attempt
// failures / model calls), repair rate (repair attempts / model calls),
// and divergence counts by violation kind. The violation kinds map to the
// protocol's drift layer: numbers not in context and citations that do
// not resolve are hallucinations / bad datasets; trade talk without a
// kill is conflicting guidance.
function computeDriftStats(records) {
var byModel = {};
(records || []).forEach(function (r) {
if (!r || r.groq_called!== true) return;
var m = r.model || "unknown";
var st = byModel[m] || (byModel[m] = { model: m, calls: 0, failures: 0, repairs: 0, divergences: { numbers: 0, citations: 0, tradeTalk: 0}});
st.calls++;
var first = r.raw_answer_validation || { passed: true, violations: []};
if (first.passed === false) {
st.failures++;
(first.violations || []).forEach(function (v) {
if (v.indexOf("number ") === 0) st.divergences.numbers++;
else if (v.indexOf("citation ") === 0) st.divergences.citations++;
else if (v.indexOf("trade talk") === 0) st.divergences.tradeTalk++;
});
}
if (r.repaired === true) st.repairs++;
});
Object.keys(byModel).forEach(function (m) {
var st = byModel[m];
st.failureRate = st.calls? st.failures / st.calls: 0;
st.repairRate = st.calls? st.repairs / st.calls: 0;
});
return byModel;
}

function checkDrift(stats, thresholds) {
var t = thresholds || DRIFT_THRESHOLDS;
var flags = [];
if (!stats || stats.calls < t.minCalls) return { flagged: false, flags: flags};
if (stats.failureRate > t.maxFailureRate) flags.push("failure rate " + (stats.failureRate * 100).toFixed(0) + "% exceeds " + (t.maxFailureRate * 100).toFixed(0) + "%");
if (stats.repairRate > t.maxRepairRate) flags.push("repair rate " + (stats.repairRate * 100).toFixed(0) + "% exceeds " + (t.maxRepairRate * 100).toFixed(0) + "%");
return { flagged: flags.length > 0, flags: flags};
}

// Runs the monitor over the in-process buffer for one model. Returns the
// rates, the flags, and a plain notice for the panel when flagged.
function recordDriftRun(buffer, model) {
var stats = computeDriftStats(buffer)[model] || { model: model, calls: 0, failures: 0, repairs: 0, divergences: { numbers: 0, citations: 0, tradeTalk: 0}, failureRate: 0, repairRate: 0};
var check = checkDrift(stats, DRIFT_THRESHOLDS);
var notice = "";
if (check.flagged) {
notice = "This model has drifted: its recent answers needed repair " + (stats.repairRate * 100).toFixed(0) + "% of the time and failed validation " + (stats.failureRate * 100).toFixed(0) + "% of the time (" + stats.calls + " calls).";
}
return {
model: model,
calls: stats.calls,
failureRate: stats.failureRate,
repairRate: stats.repairRate,
divergences: stats.divergences,
flags: check.flags,
flagged: check.flagged,
thresholdsVersion: DRIFT_THRESHOLDS_VERSION,
notice: notice,
};
}

// A model swap is itself a drift event. Compare the new model's rates
// against the old model's, from the same log, so Milly sees whether the
// swap made things better or worse. Returns null when there is nothing
// to compare (no prior model in the buffer).
function detectModelSwap(buffer, currentModel) {
if (!buffer || buffer.length === 0) return null;
var prev = null;
for (var i = buffer.length - 1; i >= 0; i--) {
if (buffer[i].model && buffer[i].model!== currentModel) { prev = buffer[i].model; break;}
}
if (!prev) return null;
var stats = computeDriftStats(buffer);
return {
previousModel: prev,
previousStats: stats[prev] || null,
currentModel: currentModel,
currentStats: stats[currentModel] || null,
};
}

// ---- Audit log: the audit law (Axiom IV) ----
// One record per layer call, and the record keeps the whole attempt, not
// just what passed the gates: the question, the context ids handed to the
// model, the scope, the mode, the model id and version, the RAW model
// answer before validation (what the model intended), every validation
// failure with the exact rule that failed, the repair attempt and its
// result, and the final answer actually served. A failed or rejected raw
// answer is logged in full, never discarded. That way, when the model is
// swapped, Milly can compare what each model intended against what passed
// the gates, and a model that keeps attempting bad answers is visible even
// if the gates catch them all. Never the key.
function buildAuditRecord(fields) {
return {
event: "graph_chat_audit",
ts: new Date().toISOString(),
question: fields.question || "",
context_ids: fields.context_ids || [],
scope: fields.scope || "owner",
mode: fields.mode || "record",
caller: fields.caller || "unknown",
model: GROQ_MODEL,
model_version: GROQ_MODEL_VERSION,
raw_answer: fields.raw_answer!== undefined? fields.raw_answer: null,
raw_answer_validation: fields.raw_answer_validation || null,
repair: fields.repair || null,
served_answer: fields.served_answer!== undefined? fields.served_answer: null,
state: fields.state || "",
validation: fields.validation || null,
groq_called:!!fields.groq_called,
repaired:!!fields.repaired,
attempt: fields.attempt || { level: 1, reason: "advisory answer, no commitment", alert: false, gate: "n/a"},
drift: fields.drift || null,
};
}

function auditLog(entry) {
try {
console.log(JSON.stringify(entry));
} catch (_e) { /* logging must never break the answer */}
}

function pushAuditBuffer(record) {
auditBuffer.push(record);
if (auditBuffer.length > AUDIT_BUFFER_MAX) auditBuffer.shift();
}

function corsHeaders(origin) {
return {
"Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN? origin: "null",
"Access-Control-Allow-Methods": "POST, OPTIONS",
"Access-Control-Allow-Headers": "Content-Type",
"Content-Type": "application/json",
};
}

async function callGroq(groqKey, systemPrompt, userContent) {
var res = await fetch(GROQ_URL, {
method: "POST",
headers: { "Content-Type": "application/json", Authorization: "Bearer " + groqKey},
body: JSON.stringify({
model: GROQ_MODEL,
temperature: 0.2,
max_tokens: 600,
messages: [
{ role: "system", content: systemPrompt},
{ role: "user", content: userContent},
],
}),
});
if (!res.ok) {
var err = new Error("groq_error");
err.status = res.status;
throw err;
}
var groq = await res.json();
return groq && groq.choices && groq.choices[0] && groq.choices[0].message
? groq.choices[0].message.content
: "";
}

// Finish one call: classify, drift-check, write the single audit record,
// and return the response body fields shared by ask and compare.
function finishCall(opts) {
var attemptInfo = classifyAttemptLevel(opts.question, opts.rawAnswer || "", opts.mode);
if (opts.servedAnswer && opts.servedAnswer!== PLAIN_NOT_RECORDED && opts.servedAnswer!== PLAIN_CANNOT_ANSWER) {
var servedInfo = classifyAttemptLevel(opts.question, opts.servedAnswer, opts.mode);
if (servedInfo.level > attemptInfo.level) attemptInfo = servedInfo;
}
var gate = opts.gate;
var alert = attemptInfo.level >= 3;
// A blocked L3/L4 attempt alerts exactly the same as a passed one:
// blocking is not silence.
var record = buildAuditRecord({
question: (opts.question || "").slice(0, 200),
context_ids: opts.contextIds,
scope: opts.scope,
mode: opts.mode,
caller: opts.caller,
raw_answer: opts.rawAnswer!== undefined? opts.rawAnswer: null,
raw_answer_validation: opts.rawValidation || null,
repair: opts.repair || null,
served_answer: opts.servedAnswer!== undefined? opts.servedAnswer: null,
state: opts.state,
validation: opts.validation || null,
groq_called:!!opts.groqCalled,
repaired:!!opts.repaired,
attempt: { level: attemptInfo.level, reason: attemptInfo.reason, alert: alert, gate: gate},
drift: null,
});
pushAuditBuffer(record);
// Drift runs on every call over the buffer; its result rides in the same
// audit record, and a flag also gets its own drift_monitor record so the
// monitor's own runs are in the log.
var drift = recordDriftRun(auditBuffer, GROQ_MODEL);
record.drift = drift;
if (drift.flagged) {
auditLog({ event: "drift_monitor", ts: new Date().toISOString(), model: GROQ_MODEL, model_version: GROQ_MODEL_VERSION, thresholdsVersion: DRIFT_THRESHOLDS_VERSION, calls: drift.calls, failureRate: drift.failureRate, repairRate: drift.repairRate, divergences: drift.divergences, flags: drift.flags, notice: drift.notice});
}
// Model swap detection: the swap itself is a drift event.
var swap = detectModelSwap(auditBuffer, GROQ_MODEL);
if (swap && swap.previousModel) {
var swapKey = swap.previousModel + "->" + GROQ_MODEL;
if (!swapLogged[swapKey]) {
swapLogged[swapKey] = true;
auditLog({ event: "model_swap", ts: new Date().toISOString(), previousModel: swap.previousModel, previousStats: swap.previousStats, currentModel: swap.currentModel, currentStats: swap.currentStats});
}
}
auditLog(record);
return {
attempt: { level: attemptInfo.level, reason: attemptInfo.reason, alert: alert, gate: gate},
drift: drift,
drift_flagged: drift.flagged,
};
}

exports.handler = async (event) => {
const origin = event.headers && (event.headers.origin || event.headers.Origin);
const headers = corsHeaders(origin);

if (event.httpMethod === "OPTIONS") {
return { statusCode: 204, headers, body: ""};
}
if (event.httpMethod!== "POST") {
return { statusCode: 405, headers, body: JSON.stringify({ error: "method_not_allowed"})};
}

const groqKey = process.env.GROQ_API_KEY;
if (!groqKey) {
return { statusCode: 500, headers, body: JSON.stringify({ error: "not_configured"})};
}

let body;
try {
body = JSON.parse(event.body || "{}");
} catch (_e) {
return { statusCode: 400, headers, body: JSON.stringify({ error: "bad_json"})};
}

const action = typeof body.action === "string"? body.action: "ask";
const scope = resolveScope(body.scope);
const caller = typeof body.caller === "string" && body.caller? body.caller: "unknown";

// Scoping, enforced by the layer: context outside the asker's scope is
// dropped before any model call. A member scope can never receive firm
// items, even if the caller sends them. Owner scope is the full firm book.
const context = normalizeContext(scopeContext(body.context, scope));
const contextIds = context.map(function (c) { return c.id;});
const contextText = contextTextOf(context);

// ---- Action: validate (draft validation, no model call) ----
// Bobby runs a draft (brief, trade package, Discord post) through the
// layer's validator before writing it: every number checked against
// context, every trade mention checked for a kill. The no-inventing check
// applies to Bobby's own output too.
if (action === "validate") {
const draft = typeof body.draft === "string"? body.draft: "";
if (!draft) {
return { statusCode: 400, headers, body: JSON.stringify({ error: "draft_required"})};
}
const vMode = body.mode === "teach"? "teach": "record";
const validation = validateAnswer(draft, context, vMode, body.question || "", scope);
const lvl = classifyAttemptLevel(body.question || "", draft, vMode);
const alert = lvl.level >= 3;
const record = buildAuditRecord({
question: (body.question || "").slice(0, 200),
context_ids: contextIds,
scope: scope,
mode: vMode,
caller: caller,
raw_answer: draft,
raw_answer_validation: validation,
repair: null,
served_answer: null,
state: "draft_validation",
validation: validation,
groq_called: false,
repaired: false,
attempt: { level: lvl.level, reason: lvl.reason, alert: alert, gate: "n/a"},
drift: null,
});
pushAuditBuffer(record);
record.drift = recordDriftRun(auditBuffer, GROQ_MODEL);
auditLog(record);
return {
statusCode: 200, headers,
body: JSON.stringify({ valid: validation.passed, violations: validation.violations, level: lvl.level, reason: lvl.reason, alert: alert, state: "draft_validation", model: GROQ_MODEL, model_version: GROQ_MODEL_VERSION, cited: extractCitations(draft).filter(function (id) { return contextIds.indexOf(id) >= 0;}), context_ids: contextIds, mode: vMode, scope: scope, caller: caller, groq_called: false, drift: record.drift, drift_flagged: record.drift.flagged}),
};
}

// ---- Actions ask and compare: a question is required ----
const question = typeof body.question === "string"? body.question.trim(): "";
if (action === "compare") {
if (!body.finding || typeof body.finding.text!== "string" ||!body.finding.text.trim()) {
return { statusCode: 400, headers, body: JSON.stringify({ error: "finding_required"})};
}
}
if (!question && action === "ask") {
return { statusCode: 400, headers, body: JSON.stringify({ error: "question_required"})};
}
if (question.length > 2000) {
return { statusCode: 400, headers, body: JSON.stringify({ error: "question_too_long"})};
}

const mode = action === "compare"? "record": detectMode(question);
const teachWithBook = mode === "teach" && scope === "owner" && context.length > 0;

// No model call without context in record mode. The plain line comes
// from code, without spending a token. The attempt is still classified
// and still alerts at L3/L4: blocking is not silence.
if (mode === "record" && context.length === 0) {
const tail = finishCall({
question: question, contextIds: contextIds, scope: scope, caller: caller,
rawAnswer: null, rawValidation: null, repair: null,
servedAnswer: PLAIN_NOT_RECORDED, state: "not_recorded",
validation: { passed: true, violations: []},
groqCalled: false, repaired: false, mode: mode, gate: "answer_blocked",
});
return {
statusCode: 200, headers,
body: JSON.stringify({ answer: PLAIN_NOT_RECORDED, model: GROQ_MODEL, model_version: GROQ_MODEL_VERSION, cited: [], context_ids: [], mode: mode, scope: scope, caller: caller, state: "not_recorded", validation: { passed: true, violations: []}, groq_called: false, repaired: false, attempt: tail.attempt, drift: tail.drift, drift_flagged: tail.drift_flagged}),
};
}

let systemPrompt;
let userContent;
let extraAllowed = [];
if (action === "compare") {
const finding = body.finding;
systemPrompt = SYSTEM_PROMPT_COMPARE;
userContent = "Web finding (source: " + (finding.source || "web") + "):\n" + finding.text + "\n\nGraph context:\n" + contextText + "\n\nQuestion: Does the graph confirm, contradict, or extend this finding? Answer with a verdict word first: CONFIRM, CONTRADICT, or EXTEND. Cite graph ids for every graph claim.";
extraAllowed = extractNumbers(finding.text);
} else if (mode === "teach" && teachWithBook) {
systemPrompt = SYSTEM_PROMPT_TEACH_WITH_BOOK;
userContent = "Teach this using the owner's real records below as your examples.\n\nGraph context (the owner's book):\n" + contextText + "\n\nQuestion: " + question;
} else if (mode === "teach") {
systemPrompt = SYSTEM_PROMPT_TEACH;
userContent = "Question: " + question;
} else {
systemPrompt = SYSTEM_PROMPT_RECORD;
userContent = "Graph context:\n" + contextText + "\n\nQuestion: " + question;
}

let answer;
try {
answer = await callGroq(groqKey, systemPrompt, userContent);
} catch (e) {
const errRecord = buildAuditRecord({
question: question.slice(0, 200),
context_ids: contextIds,
scope: scope,
mode: mode,
caller: caller,
raw_answer: null,
raw_answer_validation: null,
repair: null,
served_answer: null,
state: "groq_error",
validation: null,
groq_called: false,
repaired: false,
attempt: { level: classifyAttemptLevel(question, "", mode).level, reason: "model unreachable", alert: false, gate: "n/a"},
drift: null,
});
pushAuditBuffer(errRecord);
auditLog(errRecord);
if (e && e.message === "groq_error") {
return { statusCode: 502, headers, body: JSON.stringify({ error: "groq_error", status: e.status})};
}
return { statusCode: 502, headers, body: JSON.stringify({ error: "groq_unreachable"})};
}

const rawAnswer = answer;
let validation = validateAnswer(answer, context, mode, question, scope, extraAllowed);
let repaired = false;
let repair = null;

// One repair attempt, naming the exact violation. Then the fallback.
if (!validation.passed) {
try {
var repairContent = userContent + "\n\nYour last answer was: " + answer + "\n\nIt failed the layer checks: " + validation.violations.join("; ") + (mode === "teach" &&!teachWithBook
? ". Answer again as general teaching only: remove any trade recommendation, do not add a kill criterion, and never state a firm price, fill, position, or book figure."
: ". Answer again, using only the numbers in the graph context above, citing only ids from the context, and stating the kill criterion. If the context does not hold it, say so.");
const repairedAnswer = await callGroq(groqKey, systemPrompt, repairContent);
repaired = true;
const repairValidation = validateAnswer(repairedAnswer, context, mode, question, scope, extraAllowed);
repair = { answer: repairedAnswer, validation: repairValidation};
answer = repairedAnswer;
validation = repairValidation;
} catch (e) {
if (e && e.message === "groq_error") {
return { statusCode: 502, headers, body: JSON.stringify({ error: "groq_error", status: e.status})};
}
return { statusCode: 502, headers, body: JSON.stringify({ error: "groq_unreachable"})};
}
}

if (!validation.passed) {
const tail = finishCall({
question: question, contextIds: contextIds, scope: scope, caller: caller,
rawAnswer: rawAnswer, rawValidation: validateAnswer(rawAnswer, context, mode, question, scope, extraAllowed),
repair: repair,
servedAnswer: PLAIN_CANNOT_ANSWER, state: "not_recorded",
validation: validation,
groqCalled: true, repaired: repaired, mode: mode, gate: "answer_blocked",
});
const failBody = { answer: PLAIN_CANNOT_ANSWER, model: GROQ_MODEL, model_version: GROQ_MODEL_VERSION, cited: [], context_ids: contextIds, mode: mode, scope: scope, caller: caller, state: "not_recorded", validation: validation, groq_called: true, repaired: repaired, attempt: tail.attempt, drift: tail.drift, drift_flagged: tail.drift_flagged};
if (action === "compare") {
failBody.finding_verdict = "UNCLEAR";
failBody.contradiction = false;
failBody.candidate_intake = null;
}
return { statusCode: 200, headers, body: JSON.stringify(failBody)};
}

if (mode === "teach" && teachWithBook && answer.indexOf("Teaching with your book")!== 0 && answer.indexOf("General knowledge")!== 0) {
answer = "Teaching with your book: " + answer;
} else if (mode === "teach" &&!teachWithBook && answer.indexOf("General knowledge")!== 0) {
answer = "General knowledge: " + answer;
}

const cited = extractCitations(answer).filter(function (id) { return contextIds.indexOf(id) >= 0;});
let state = "answered_from_graph";
if (mode === "teach") state = teachWithBook? "teaching_with_book": "teaching_general";
if (action === "compare") state = "finding_compared";

const tail = finishCall({
question: question, contextIds: contextIds, scope: scope, caller: caller,
rawAnswer: rawAnswer, rawValidation: validateAnswer(rawAnswer, context, mode, question, scope, extraAllowed),
repair: repair,
servedAnswer: answer, state: state,
validation: validation,
groqCalled: true, repaired: repaired, mode: mode, gate: "answer_served",
});
const okBody = { answer: answer, model: GROQ_MODEL, model_version: GROQ_MODEL_VERSION, cited: cited, context_ids: contextIds, mode: mode, scope: scope, caller: caller, state: state, validation: validation, groq_called: true, repaired: repaired, attempt: tail.attempt, drift: tail.drift, drift_flagged: tail.drift_flagged};
if (action === "compare") {
const m = answer.match(/\b(CONFIRM|CONTRADICT|EXTEND)\b/i);
const verdict = m? m[1].toUpperCase(): "UNCLEAR";
okBody.finding_verdict = verdict;
okBody.contradiction = verdict === "CONTRADICT";
// New facts enter as candidate intake with evidence, never as asserted
// truth. The layer never writes to the graph; the caller files this.
okBody.candidate_intake = { text: body.finding.text, source: body.finding.source || "web", verdict: verdict, evidence: cited, scope: scope};
}
return { statusCode: 200, headers, body: JSON.stringify(okBody)};
};

// Test hooks: pure layer functions, no key, no network.
exports._layer = {
detectMode: detectMode,
resolveScope: resolveScope,
scopeContext: scopeContext,
normalizeContext: normalizeContext,
extractNumbers: extractNumbers,
buildAllowedNumbers: buildAllowedNumbers,
numberAllowed: numberAllowed,
extractCitations: extractCitations,
tickersNamed: tickersNamed,
hasTradeTalk: hasTradeTalk,
validateAnswer: validateAnswer,
classifyAttemptLevel: classifyAttemptLevel,
computeDriftStats: computeDriftStats,
checkDrift: checkDrift,
recordDriftRun: recordDriftRun,
detectModelSwap: detectModelSwap,
buildAuditRecord: buildAuditRecord,
DRIFT_THRESHOLDS: DRIFT_THRESHOLDS,
DRIFT_THRESHOLDS_VERSION: DRIFT_THRESHOLDS_VERSION,
_resetAuditBuffer: function () { auditBuffer.length = 0; },
};
