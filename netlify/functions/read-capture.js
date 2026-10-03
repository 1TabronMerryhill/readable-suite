/* Read training capture + grader.
   POST /.netlify/functions/read-capture
   Body: { messages: [{role, content}], reportId, test }
   The buyer opted in on the report screen ("Help Read get sharper").
   This function grades Read's replies against the communication codebook
   (Haiku, cheap) and stores transcript + grade in Airtable ("Read Training"
   table, SPIN base) when AIRTABLE_TOKEN is configured. Grading never fails
   the request: failures return graded:false / stored:false. */

var API_URL = "https://api.anthropic.com/v1/messages";
var ANTHROPIC_VERSION = "2023-06-01";
var MODEL = process.env.READ_MODEL || "claude-haiku-4-5-20251001";
var AIRTABLE_API = "https://api.airtable.com/v0";
var TRAINING_BASE = "appHDR9CU6WjHYZdy"; // SPIN Operating Control Center
var TRAINING_TABLE = "Read Training";

var GRADE_SYSTEM = [
  "You are grading Read, an AI co-pilot's, conversation replies against a communication codebook.",
  "Score ONLY Read's (assistant) replies. The buyer's messages are context.",
  "",
  "Principles (7 = exemplary, 1 = failing):",
  "- C2 Emotionally intelligent: resonates with the user's emotions while staying grounded. Never flat, never sycophantic.",
  "- V2 Warm and interesting: warmth from clarity and matching the user's vibe. No emoji, slang, or exaggerated enthusiasm.",
  "- V1 Conversational: plain natural language, short sentences, active voice. No filler.",
  "- S2 Avoid AI style: no \"Certainly!\", no \"bottom line:\", no self-announcing, no templated headers, no emoji spam.",
  "- C1 Helpful: the user can act without re-verifying. Answers what THIS person needs, in their terms.",
  "- C3 Honest: no hedging, guessing, or overclaiming. Surfaces uncertainty plainly.",
  "",
  "Output STRICT JSON only — no markdown fences, no commentary — with exactly this shape:",
  '{"grade": <1-7 overall. Weakest principle sets the ceiling: any principle at 1-2 caps the overall at 3.>,',
  ' "misses": [{"principle": "V2", "quote": "<Read\\u2019s exact words>", "why": "<one sentence>"}],',
  ' "suggested_patch": "<one concrete sentence to add to Read\\u2019s system prompt that would fix the worst miss, or empty string when grade >= 6>"}'
].join("\n");

function json(statusCode, obj) {
  return { statusCode: statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function cleanMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(function (m) {
      return m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim();
    })
    .map(function (m) { return { role: m.role, content: m.content.slice(0, 2000) }; })
    .slice(-30);
}

function formatTranscript(messages) {
  return messages.map(function (m) {
    return (m.role === "user" ? "BUYER: " : "READ: ") + m.content;
  }).join("\n\n");
}

async function gradeTranscript(key, transcript) {
  var apiHeaders = {
    "Content-Type": "application/json",
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION
  };
  if (process.env.ANTHROPIC_WORKSPACE_ID) {
    apiHeaders["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID;
  }
  var resp = await fetch(API_URL, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: GRADE_SYSTEM,
      messages: [{ role: "user", content: "Grade this conversation:\n\n" + transcript }]
    })
  });
  if (!resp.ok) return null;
  var data = await resp.json();
  var text = (data.content || []).map(function (b) { return b.text || ""; }).join("");
  var start = text.indexOf("{");
  var end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    var parsed = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed.grade !== "number") return null;
    return parsed;
  } catch (e) { return null; }
}

async function storeTraining(token, record) {
  var resp = await fetch(AIRTABLE_API + "/" + TRAINING_BASE + "/" + encodeURIComponent(TRAINING_TABLE), {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fields: record })
  });
  if (!resp.ok) return null;
  var data = await resp.json();
  return data.id || true;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { ok: false, reason: "method_not_allowed" });

  var key = process.env.ANTHROPIC_API_KEY;
  var body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, reason: "bad_json" }); }

  var messages = cleanMessages(body.messages);
  if (!messages.length) return json(400, { ok: false, reason: "empty_messages" });
  if (!key) return json(200, { ok: false, reason: "not_configured" });

  var transcript = formatTranscript(messages);
  var grade = null;
  try { grade = await gradeTranscript(key, transcript); } catch (e) { grade = null; }

  // Test mode: grade only, never store.
  if (body.test) {
    return json(200, { ok: true, stored: false, graded: !!grade, grade: grade });
  }

  var stored = null;
  var airtableToken = process.env.AIRTABLE_TOKEN;
  if (airtableToken && grade) {
    try {
      stored = await storeTraining(airtableToken, {
        "Transcript": transcript.slice(0, 100000),
        "Grade": grade.grade,
        "Misses": JSON.stringify(grade.misses || []).slice(0, 5000),
        "Suggested patch": grade.suggested_patch || "",
        "Report ID": String(body.reportId || "")
      });
    } catch (e) { stored = null; }
  }

  return json(200, {
    ok: true,
    stored: !!stored,
    recordId: typeof stored === "string" ? stored : undefined,
    graded: !!grade,
    grade: grade ? grade.grade : undefined
  });
};
