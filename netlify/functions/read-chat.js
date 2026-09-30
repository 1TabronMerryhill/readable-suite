/* Read/co-pilot conversational layer (v1.1).
   Proxies chat between the assessment page and the Anthropic Messages API.
   The LLM structures evidence only — scoring stays deterministic in
   read-copilot.js (same answers in, same score out). The conversation
   transcript is never stored anywhere by us; only the buyer's confirmed
   answers and report are kept as the lead record.

   Env: ANTHROPIC_API_KEY (required), READ_MODEL (optional override). */

"use strict";

var API_URL = "https://api.anthropic.com/v1/messages";
var MODEL = process.env.READ_MODEL || "claude-haiku-4-5";
var ANTHROPIC_VERSION = "2023-06-01";

var DIM_CRITERIA = [
  "D1 Problem boundedness. Solid (2): one workflow with a clear start and end. Partial (1): department-level scope. Weak (0): unbounded or unclear.",
  "D2 Measurable outcome. Solid (2): intended outcome stated with a number or a date. Partial (1): described but not measurable. Weak (0): not defined.",
  "D3 AI-task fit. Solid (2): AI proposes or drafts; a human reviews and decides. Partial (1): AI acts within bounds with spot-checks. Weak (0): AI decides or publishes directly.",
  "D4 Alternative weighed. Solid (2): a non-AI or simpler approach was weighed and rejected for a stated reason. Partial (1): briefly considered. Weak (0): never considered.",
  "D5 Inputs and data boundaries. Solid (2): authorized inputs defined; sensitive data excluded or governed. Partial (1): loosely defined. Weak (0): sensitive or undefined inputs.",
  "D6 Human authority. Solid (2): a named human holds final decision authority. Partial (1): a team with no single owner. Weak (0): no human accountable.",
  "D7 Acceptance and verification. Solid (2): written, checkable acceptance criteria; outputs verified against source evidence. Partial (1): informal verification. Weak (0): outputs used unverified.",
  "D8 Failure handling and output discipline. Solid (2): documented exception path; outputs accepted, revised, rejected, or escalated — never auto-accepted. Partial (1): informal handling. Weak (0): no failure plan; outputs auto-accepted."
].join("\n");

var CHAT_SYSTEM = [
  "You are Read, the co-pilot for Readable's $150 AI Readiness Assessment.",
  "You are in an open conversation with a buyer who has paid for a judgment about whether ONE workflow in their organization is ready for AI.",
  "",
  "Your job in this conversation: understand their workflow well enough to fill in evidence for 8 dimensions. You do NOT score, judge, recommend, or predict any outcome — a deterministic rubric does that after the buyer confirms what you heard. Never mention scores, verdicts, bands, or the rubric's math.",
  "",
  "The 8 evidence areas (gather them naturally, in whatever order fits the conversation):",
  DIM_CRITERIA,
  "",
  "How to talk:",
  "- Warm, plain-spoken, curious. Short messages: one question at a time, occasionally two when they pair naturally.",
  "- Let them talk in their own words. Ask follow-ups when an answer is vague (\"when you say handled — who does what, exactly?\").",
  "- Acknowledge what they said, then move to the next gap. Don't interrogate.",
  "- Early and naturally, ask their name and organization (\"who am I talking with?\"). Do NOT ask for their email — that comes after the conversation.",
  "- If they go off-topic, steer back gently: the assessment only covers the one workflow.",
  "- Never invent details they didn't give. Never promise an outcome.",
  "- When you have enough evidence for all 8 areas, close with something like \"I think I've got the full picture — want to see what I heard before the rubric judges it?\" and end your message with the exact token [[READY]] on its own line.",
  "",
  "Keep every reply under 120 words unless they ask for more."
].join("\n");

var EXTRACT_SYSTEM = [
  "You are the evidence extractor for Readable's Readiness Assessment.",
  "Given the conversation transcript, output STRICT JSON only — no markdown fences, no commentary — with exactly this shape:",
  '{"contact":{"name":"","org":"","role":""},"context":{"problem":"","steps":"","measure":""},"dimensions":[{"id":"D1","score":0,"quote":""}, ... all of D1..D8]}',
  "Score each dimension against these criteria:",
  DIM_CRITERIA,
  "Rules:",
  "- quote must be the buyer's own words from the transcript, short and verbatim. Empty string when there is no supporting statement.",
  "- Base scores ONLY on what the buyer actually said. Be conservative: vague claims score 1 at most.",
  "- contact fields: fill from the transcript when mentioned, otherwise empty strings.",
  "- context.problem: the problem in their words. context.steps: the workflow steps in their words. context.measure: how they'll know in 90 days it worked."
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

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { ok: false, reason: "method_not_allowed" });

  var key = process.env.ANTHROPIC_API_KEY;
  var body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, reason: "bad_json" }); }

  if (body.mode === "probe") {
    return json(200, { ok: true, configured: !!key });
  }

  if (!key) return json(200, { ok: false, reason: "not_configured" });

  var mode = body.mode === "extract" ? "extract" : "chat";
  var messages = cleanMessages(body.messages);
  if (!messages.length) return json(400, { ok: false, reason: "empty_messages" });

  var system = mode === "extract" ? EXTRACT_SYSTEM : CHAT_SYSTEM;
  var maxTokens = mode === "extract" ? 2000 : 500;

  var resp;
  try {
    resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: system, messages: messages })
    });
  } catch (e) {
    return json(502, { ok: false, reason: "upstream_unreachable" });
  }

  if (!resp.ok) {
    return json(502, { ok: false, reason: "upstream_error", status: resp.status });
  }

  var data = await resp.json();
  var text = (data.content || [])
    .filter(function (b) { return b && b.type === "text"; })
    .map(function (b) { return b.text; })
    .join("");

  if (mode === "extract") {
    var packet;
    try {
      packet = JSON.parse(text);
    } catch (e) {
      var m = text.match(/\{[\s\S]*\}/);
      if (m) { try { packet = JSON.parse(m[0]); } catch (e2) { packet = null; } }
    }
    if (!packet || !Array.isArray(packet.dimensions)) {
      return json(502, { ok: false, reason: "extract_parse_failed" });
    }
    return json(200, { ok: true, packet: packet });
  }

  return json(200, { ok: true, text: text });
};
