/* Read profile chat: the ongoing conversation where Read learns the buyer.
   POST /.netlify/functions/read-profile
   Body: { mode: "chat"|"extract", messages: [{role, content}], profile }
   chat: warm profile-building conversation. extract: STRICT JSON profile update. */

var API_URL = "https://api.anthropic.com/v1/messages";
var ANTHROPIC_VERSION = "2023-06-01";
var MODEL = process.env.READ_MODEL || "claude-haiku-4-5-20251001";

var PROFILE_CHAT_SYSTEM = [
  "You are Read, the co-pilot for Readable. This is the buyer's profile chat — an ongoing conversation where you learn who they are and how their organization works, so every future assessment starts smarter.",
  "You are the load-bearing half of the pairing: you carry the curiosity; the buyer holds the judgment. Be calm and unhurried — the feeling of this working is calm and productive.",
  "Draw out naturally over time: their name, organization, role, the workflows they own, where the load sits, what they have tried. Never interrogate — one thread at a time.",
  "Reference what you already know about them when it fits; never make them repeat themselves.",
  "Emotional attunement: match their state. Overwhelmed gets calm and short. Skeptical gets crisp and evidence-first. Never flat, never gushing. No emoji. Ever.",
  "Never invent details they did not give. If they correct you, accept it plainly.",
  "Keep every reply under 100 words."
].join("\n");

var PROFILE_EXTRACT_SYSTEM = [
  "You extract profile updates from a Read profile-chat transcript.",
  "Output STRICT JSON only — no markdown fences, no commentary — with exactly this shape:",
  '{"name":"","org":"","role":"","workflows":[],"load_notes":"","summary":""}',
  "Rules:",
  "- Fill only what the transcript supports; empty string or empty array otherwise.",
  "- workflows: short labels of workflows they own or mention.",
  "- load_notes: where they feel the weight, in their words.",
  "- summary: one plain sentence describing them and their operation."
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
  if (!key) return json(200, { ok: false, reason: "not_configured" });

  var mode = body.mode === "extract" ? "extract" : "chat";
  var messages = cleanMessages(body.messages);
  if (!messages.length) return json(400, { ok: false, reason: "empty_messages" });

  var system = mode === "extract" ? PROFILE_EXTRACT_SYSTEM : PROFILE_CHAT_SYSTEM;
  if (mode === "chat" && body.profile && typeof body.profile.summary === "string" && body.profile.summary) {
    system += "\n\nWhat you already know about this buyer: " + body.profile.summary.slice(0, 500);
  }

  var apiHeaders = {
    "Content-Type": "application/json",
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION
  };
  if (process.env.ANTHROPIC_WORKSPACE_ID) {
    apiHeaders["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID;
  }

  var resp;
  try {
    resp = await fetch(API_URL, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ model: MODEL, max_tokens: mode === "extract" ? 600 : 400, system: system, messages: messages })
    });
  } catch (e) { return json(502, { ok: false, reason: "upstream_unreachable" }); }
  if (!resp.ok) return json(502, { ok: false, reason: "upstream_error", status: resp.status });

  var data;
  try { data = await resp.json(); } catch (e) { return json(502, { ok: false, reason: "bad_upstream" }); }
  var text = (data.content || []).map(function (b) { return b.text || ""; }).join("").trim();
  if (!text) return json(502, { ok: false, reason: "empty_reply" });

  if (mode === "extract") {
    var start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return json(502, { ok: false, reason: "bad_extract" });
    try { return json(200, { ok: true, profile: JSON.parse(text.slice(start, end + 1)) }); }
    catch (e) { return json(502, { ok: false, reason: "bad_extract" }); }
  }
  return json(200, { ok: true, text: text });
};
