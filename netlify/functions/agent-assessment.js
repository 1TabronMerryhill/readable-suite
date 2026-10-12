/* Readable suite — agent gate: submit an assessment request.
   POST JSON {business_name, contact_email, contact_name?, workflow_description,
   verdict, score, recommended_intervention, idempotency_key?}
   Auth: x-agent-key header checked (timing-safe) against env AGENT_API_KEY.
   Missing/invalid key -> 401. The env var is set in the Netlify dashboard;
   when it is unset, no key is accepted.
   Reuses intake.js: synthesizes a "readiness-assessment" submission so the
   record lands exactly like a human-submitted one — Business Systems Requests
   with Status "Queued" for human review. Humans hold the irreversible calls. */

const crypto = require("crypto");
const intake = require("./intake.js");

const REQUIRED = [
  "business_name",
  "contact_email",
  "workflow_description",
  "verdict",
  "score",
  "recommended_intervention",
];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function keyMatches(provided) {
  const expected = process.env.AGENT_API_KEY || "";
  if (!expected || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function handleEvent(event) {
  if (event.httpMethod !== "POST") return intake._bad(405, "Method not allowed");

  const headers = event.headers || {};
  const provided = headers["x-agent-key"] || headers["X-Agent-Key"] || "";
  if (!keyMatches(provided)) {
    return {
      statusCode: 401,
      body: JSON.stringify({ ok: false, error: "Missing or invalid agent key" }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return intake._bad(400, "Invalid JSON");
  }

  for (const key of REQUIRED) {
    const v = body[key];
    if (v === undefined || v === null || String(v).trim() === "") {
      return intake._bad(400, `Missing required field: ${key}`);
    }
  }
  if (!EMAIL_RE.test(String(body.contact_email))) {
    return intake._bad(400, "Invalid email address");
  }

  // idempotency_key is accepted but not enforced in v1: no dedupe store.
  // Documented in .well-known/agent.json — callers must not retry blindly.
  const fields = {
    business_name: String(body.business_name).trim(),
    contact_email: String(body.contact_email).trim(),
    contact_name: body.contact_name ? String(body.contact_name).trim() : "",
    workflow_description: String(body.workflow_description).trim(),
    verdict: String(body.verdict).trim(),
    score: String(body.score).trim(),
    recommended_intervention: String(body.recommended_intervention).trim(),
  };

  // Pass through the governed intake path. Returns {ok:true, record_id}.
  return intake._handleEvent({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ form_id: "readiness-assessment", fields }),
  });
}

// CORS wrapper mirrors intake.js (server-to-server agents don't need CORS,
// but it costs nothing and keeps browser-based callers working).
exports.handler = async (event) => {
  const cors = intake._corsHeaders(event);
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  const res = await handleEvent(event);
  return { ...res, headers: { ...(res.headers || {}), ...cors } };
};
