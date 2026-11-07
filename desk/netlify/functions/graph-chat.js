// graph-chat.js — OpOne Capital Desk: Instruction Layer v1.
// The brain (knowledge graph + this code) gives the orders. Groq is the
// substrate: a voice, not a mind. The model originates nothing and connects
// everything. The rules live in deterministic code, never only in a prompt.
// Axiom I (Separation of Intelligence and Logic) as a built layer.
//
// Two modes, picked in code, never by the model:
// record — the question names an asset, ticker, position, price, or the
// firm's book. Strict. No graph context means no model call at all.
// teach — how / what-is / explain questions. The model may teach from
// general knowledge, labeled plainly as general knowledge, never about
// the firm's numbers.
// Member scoping: the caller passes a scope. Context items outside the
// asker's scope are dropped before the model call, so a member can never
// see the firm's book through the model. The firm is the only scope today.
// The model never acts: no tools, no function calling, no write path to
// the graph, the ledger, or any account. One constant for the model, one
// env var for the key. Every call is written to the audit log.
//
// STAGED Nov 6, 2026. GROQ_API_KEY went live Nov 7, 2026. Instruction
// Layer v1 shipped Nov 7, 2026 (citation-bracket fix first, then the layer).

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// Narrow this to the Desk origin when the subdomain is live.
const ALLOWED_ORIGIN = "https://opone.tabronmerryhill.com";

const TICKERS = [
"MU", "QCOM", "GLD", "AMD", "DUOL", "NVDA", "DIA", "SPY", "ANET", "APP",
"IREN", "AVGO", "MRVL", "GOOGL", "BRK.B", "VST", "FRO", "BE", "BTC", "ETH",
];

const RECORD_WORDS = /\b(position|portfolio|book|fill|stop|target|kill|thesis|price|trade|pnl|p&l|cash|equity|holdings|bought|sold|shares|contract|premium)\b/i;
const TEACH_START = /^(what is|what are|what does|explain|define|describe|how does|how do|why does)\b/i;
const TICKER_RE = new RegExp("\\b(" + TICKERS.map(function (t) { return t.replace(".", "\\.");}).join("|") + ")\\b");

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

// ---- Scope: the layer drops what the asker may not see ----
function scopeContext(rawContext, scope) {
var s = typeof scope === "string" && scope? scope: "firm";
return (Array.isArray(rawContext)? rawContext: []).filter(function (c) {
if (!c || typeof c.id!== "string") return false;
var cs = typeof c.scope === "string"? c.scope: "firm";
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
if (/\b(buy|sell|enter|take|open)\b/i.test(s) && TICKER_RE.test(s)) return true;
if (/^\s*(buy|sell|open|take|enter)\b/i.test(s)) return true;
if (/\byou should\s+(buy|sell|open|take|enter|go)\b/i.test(s)) return true;
}
return false;
}

// ---- Validation: deterministic, before the answer is served ----
function validateAnswer(answer, context, mode, question) {
var violations = [];
var contextIds = context.map(function (c) { return c.id;});
var contextText = contextTextOf(context);

var cites = extractCitations(answer);
cites.forEach(function (id) {
if (contextIds.indexOf(id) < 0) violations.push("citation " + id + " does not resolve to a context item");
});

if (hasTradeTalk(answer)) {
if (mode === "record") {
if (!/kill/i.test(contextText)) violations.push("trade talk without a kill criterion in the context");
} else {
violations.push("trade talk is not allowed in a teaching answer: remove the recommendation, do not add a kill criterion");
}
}

if (mode === "record") {
var ctxNums = [];
context.forEach(function (c) {
ctxNums = ctxNums.concat(extractNumbers(c.label + " " + c.evidence));
});
var allowed = buildAllowedNumbers(ctxNums, extractNumbers(question));
extractNumbers(answer).forEach(function (n) {
if (!numberAllowed(n, allowed)) violations.push("number " + n + " is not in the context and cannot be derived from it");
});
} else {
if (TICKER_RE.test(answer)) violations.push("teaching answer names a firm asset");
}

return { passed: violations.length === 0, violations: violations};
}

// ---- Audit log: server-side line, never the key ----
function auditLog(entry) {
try {
console.log(JSON.stringify(Object.assign({ event: "graph_chat", ts: new Date().toISOString()}, entry)));
} catch (_e) { /* logging must never break the answer */}
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

const question = typeof body.question === "string"? body.question.trim(): "";
if (!question) {
return { statusCode: 400, headers, body: JSON.stringify({ error: "question_required"})};
}
if (question.length > 2000) {
return { statusCode: 400, headers, body: JSON.stringify({ error: "question_too_long"})};
}

const mode = detectMode(question);
const scope = typeof body.scope === "string" && body.scope? body.scope: "firm";

// Member scoping, enforced by the layer: context outside the asker's
// scope is dropped before the model call. A member scope can never
// receive firm items, even if the caller sends them.
const context = normalizeContext(scopeContext(body.context, scope));
const contextIds = context.map(function (c) { return c.id;});
const contextText = contextTextOf(context);

// No model call without context in record mode. The plain line comes
// from code, without spending a token.
if (mode === "record" && context.length === 0) {
auditLog({ mode: mode, scope: scope, question: question.slice(0, 200), context_ids: [], model: GROQ_MODEL, validation: { passed: true, violations: []}, groq_called: false, repaired: false, state: "not_recorded"});
return {
statusCode: 200, headers,
body: JSON.stringify({ answer: PLAIN_NOT_RECORDED, model: GROQ_MODEL, cited: [], context_ids: [], mode: mode, scope: scope, state: "not_recorded", validation: { passed: true, violations: []}, groq_called: false, repaired: false}),
};
}

const systemPrompt = mode === "teach"? SYSTEM_PROMPT_TEACH: SYSTEM_PROMPT_RECORD;
const userContent = mode === "teach"
? "Question: " + question
: "Graph context:\n" + contextText + "\n\nQuestion: " + question;

let answer;
try {
answer = await callGroq(groqKey, systemPrompt, userContent);
} catch (e) {
if (e && e.message === "groq_error") {
return { statusCode: 502, headers, body: JSON.stringify({ error: "groq_error", status: e.status})};
}
return { statusCode: 502, headers, body: JSON.stringify({ error: "groq_unreachable"})};
}

let validation = validateAnswer(answer, context, mode, question);
let repaired = false;

// One repair attempt, naming the exact violation. Then the fallback.
if (!validation.passed) {
try {
var repairContent = userContent + "\n\nYour last answer was: " + answer + "\n\nIt failed the layer checks: " + validation.violations.join("; ") + (mode === "teach"
? ". Answer again as general teaching only: remove any trade recommendation, do not add a kill criterion, and never state a firm price, fill, position, or book figure."
: ". Answer again, using only the numbers in the graph context above, citing only ids from the context, and stating the kill criterion. If the context does not hold it, say so.");
answer = await callGroq(groqKey, systemPrompt, repairContent);
repaired = true;
validation = validateAnswer(answer, context, mode, question);
} catch (e) {
if (e && e.message === "groq_error") {
return { statusCode: 502, headers, body: JSON.stringify({ error: "groq_error", status: e.status})};
}
return { statusCode: 502, headers, body: JSON.stringify({ error: "groq_unreachable"})};
}
}

if (!validation.passed) {
auditLog({ mode: mode, scope: scope, question: question.slice(0, 200), context_ids: contextIds, model: GROQ_MODEL, validation: validation, groq_called: true, repaired: repaired, state: "not_recorded"});
return {
statusCode: 200, headers,
body: JSON.stringify({ answer: PLAIN_CANNOT_ANSWER, model: GROQ_MODEL, cited: [], context_ids: contextIds, mode: mode, scope: scope, state: "not_recorded", validation: validation, groq_called: true, repaired: repaired}),
};
}

if (mode === "teach" && answer.indexOf("General knowledge")!== 0) {
answer = "General knowledge: " + answer;
}

const cited = extractCitations(answer).filter(function (id) { return contextIds.indexOf(id) >= 0;});
const state = mode === "teach"? "teaching_general": "answered_from_graph";
auditLog({ mode: mode, scope: scope, question: question.slice(0, 200), context_ids: contextIds, model: GROQ_MODEL, validation: validation, groq_called: true, repaired: repaired, state: state});
return {
statusCode: 200, headers,
body: JSON.stringify({ answer: answer, model: GROQ_MODEL, cited: cited, context_ids: contextIds, mode: mode, scope: scope, state: state, validation: validation, groq_called: true, repaired: repaired}),
};
};

// Test hooks: pure layer functions, no key, no network.
exports._layer = {
detectMode: detectMode,
scopeContext: scopeContext,
normalizeContext: normalizeContext,
extractNumbers: extractNumbers,
buildAllowedNumbers: buildAllowedNumbers,
numberAllowed: numberAllowed,
extractCitations: extractCitations,
hasTradeTalk: hasTradeTalk,
validateAnswer: validateAnswer,
};
