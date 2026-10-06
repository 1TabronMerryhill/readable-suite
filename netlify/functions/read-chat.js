/* Read/co-pilot conversational layer (v1.1).
   Proxies chat between the assessment page and the Anthropic Messages API.
   The LLM structures evidence only — scoring stays deterministic in
   read-copilot.js (same answers in, same score out). The conversation
   transcript is never stored anywhere by us; only the buyer's confirmed
   answers and report are kept as the lead record.

   Env: ANTHROPIC_API_KEY (required), READ_MODEL (optional override),
   ANTHROPIC_WORKSPACE_ID (optional: required when the API key is not
   scoped to a workspace — sent as the anthropic-workspace-id header). */

"use strict";

var API_URL = "https://api.anthropic.com/v1/messages";
var MODEL = process.env.READ_MODEL || "claude-haiku-4-5-20251001";
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
  "You are in an open conversation with a buyer who is deciding whether ONE workflow in their organization is ready for AI.",
  "The conversation itself is free; the buyer pays $150 to unlock the scored report afterward. If they ask about price, say exactly that. Otherwise never bring up payment.",
  "",
  "You are the load-bearing half of the pairing: you carry the work of structuring what the buyer says; the buyer holds all judgment. Be calm and unhurried — the feeling of this working is calm and productive.",
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
  "- When you have enough evidence for all 8 areas, close with something like \"I think I've got the full picture — want to see what I heard before the rubric judges it?\"",
  "",
  "Emotional attunement (this is what makes Read feel like Read):",
  "- Read the buyer's emotional state and match it. An overwhelmed owner gets calm, short, warm replies. A skeptical operator gets crisp, evidence-first replies. A curious explorer gets room to think out loud. Never flat, never gushing.",
  "- Warmth comes from clarity and fit, never from emoji, slang, or exaggerated enthusiasm. No emoji in replies. Ever.",
  "- Plain natural sentences, one idea each. No AI-style filler: no \"Certainly!\", no \"bottom line:\", no announcing what you are about to do.",
  "- Answer what THIS person actually needs, in their terms — not the nearest generic question.",
  "- Never sycophantic: do not praise their answers to keep them talking. Curiosity is honest; flattery is not.",
  "",
  "Keep every reply under 120 words unless they ask for more.",
  "",
  "FINAL RULE \u2014 READ THIS LAST:",
  "When you have evidence for all 8 areas, that reply is your CLOSING reply. Your CLOSING reply must end with [[READY]] on its own line, like this:",
  "I think I've got the full picture \u2014 want to see what I heard before the rubric judges it?",
  "[[READY]]",
  "No exceptions. If you write a recap or summary of what you heard, that IS your closing reply and it MUST end with [[READY]]. Do NOT ask the buyer to confirm your recap in chat and do NOT end with a question — the confirmation screen right after handles that. Go straight from your recap to the [[READY]] token. The page cannot advance to the confirmation step without this exact token. Never forget it, never reword it, never put other text after it."
].join("\n");

var EXTRACT_SYSTEM = [
  "You are the evidence extractor for Readable's Readiness Assessment.",
  "Given the conversation transcript, output STRICT JSON only — no markdown fences, no commentary — with exactly this shape:",
  '{"contact":{"name":"","org":"","role":""},"context":{"problem":"","steps":"","measure":""},"dimensions":[{"id":"D1","score":0,"quote":""}, ... all of D1..D8]}',
  "Score each dimension against these criteria:",
  DIM_CRITERIA,
  "Rules:",
  "- Quote selection: quote must be the buyer's OWN words from the transcript, short and verbatim. Never quote your own messages, recaps, or summaries.",
  "- Choose the quote that most directly supports the score. For D2 prefer their stated outcome, number, date, or 90-day measure. For D4 prefer any mention of alternatives they considered, however briefly.",
  "- Leave quote empty ONLY when the topic genuinely never came up in the transcript — not when the buyer was merely vague.",
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
  var apiHeaders = {
    "Content-Type": "application/json",
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION
  };
  if (process.env.ANTHROPIC_WORKSPACE_ID) {
    apiHeaders["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID;
  }
  try {
    resp = await fetch(API_URL, {
      method: "POST",
      headers: apiHeaders,
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

  if (!/\[\[READY\]\]/.test(text)) {
    var userTurns = messages.filter(function (m) { return m.role === "user"; }).length;
    var looksClosing = /recap|what i heard|full picture|before the rubric|make sure i've got/i.test(text);
    var endsWithQuestion = /\?\s*$/.test(text);
    if (userTurns >= 5 && looksClosing && !endsWithQuestion) text += "\n[[READY]]";
  }

  return json(200, { ok: true, text: text });
};
