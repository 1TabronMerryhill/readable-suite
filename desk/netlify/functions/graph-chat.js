// graph-chat.js — OpOne Capital Desk: talk to the knowledge graph.
// The graph is the firm's memory and brain. Groq is the voice that speaks
// for it, for now. The model is replaceable: one constant, one env var.
// Same pattern as the station functions: the key lives server-side in
// GROQ_API_KEY, never in the browser. The Desk sends the question plus the
// graph context it retrieved; this function asks Groq to answer ONLY from
// that context, citing node and edge ids.
//
// STAGED Nov 6, 2026. Not deployed. It ships with the Desk site
// (opone.tabronmerryhill.com) in the next coordinated deploy
// batch, on Milly's word. The Desk site must have GROQ_API_KEY set in its
// Netlify environment, same as the Readable site already has.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// Narrow this to the Desk origin when the subdomain is live.
const ALLOWED_ORIGIN = "https://opone.tabronmerryhill.com";

const SYSTEM_PROMPT = [
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

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? origin : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

exports.handler = async (event) => {
  const origin = event.headers && (event.headers.origin || event.headers.Origin);
  const headers = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "method_not_allowed" }) };
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "not_configured" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "bad_json" }) };
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "question_required" }) };
  }
  if (question.length > 2000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "question_too_long" }) };
  }

  // Context is the graph the Desk retrieved: nodes and edges with ids,
  // labels, and evidence. Cap it so one request stays small.
  const rawContext = Array.isArray(body.context) ? body.context.slice(0, 40) : [];
  const context = rawContext
    .filter((c) => c && typeof c.id === "string")
    .map((c) => ({
      id: c.id,
      type: typeof c.type === "string" ? c.type : "",
      label: typeof c.label === "string" ? c.label : "",
      evidence: typeof c.evidence === "string" ? c.evidence.slice(0, 500) : "",
    }));
  const contextText = context.length
    ? context.map((c) => `${c.id} (${c.type}) ${c.label}${c.evidence ? " -- " + c.evidence : ""}`).join("\n")
    : "The graph returned no context for this question.";

  let groqRes;
  try {
    groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + groqKey,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Graph context:\n${contextText}\n\nQuestion: ${question}` },
        ],
      }),
    });
  } catch (_e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "groq_unreachable" }) };
  }

  if (!groqRes.ok) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "groq_error", status: groqRes.status }) };
  }

  const groq = await groqRes.json();
  const answer = groq && groq.choices && groq.choices[0] && groq.choices[0].message
    ? groq.choices[0].message.content
    : "";

  // Citations are the graph ids the answer actually references.
  // Groq sometimes cites with full-width brackets, so match both forms.
  const cited = [...new Set((answer.match(/[【\[][a-z_]+:[^\]】]+[】\]]/g) || []).map((m) => m.slice(1, -1)))]
    .filter((id) => context.some((c) => c.id === id));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ answer, model: GROQ_MODEL, cited, context_ids: context.map((c) => c.id) }),
  };
};
