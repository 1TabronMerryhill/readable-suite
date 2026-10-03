/* Read Load analysis: finds where the weight sits across the buyer's conversations.
   POST /.netlify/functions/read-load
   Body: { chats: [{name, transcript}], profile }
   Returns STRICT JSON: { loads: [{title, pain, bottleneck, evidence, severity, suggested_workflow}] } */

var API_URL = "https://api.anthropic.com/v1/messages";
var ANTHROPIC_VERSION = "2023-06-01";
var MODEL = process.env.READ_MODEL || "claude-haiku-4-5-20251001";

var LOAD_SYSTEM = [
  "You analyze a buyer's past conversations with Read (an AI co-pilot) and their profile to find where the load sits in their operation.",
  "Output STRICT JSON only — no markdown fences, no commentary — with exactly this shape:",
  '{"loads":[{"title":"","pain":"","bottleneck":"","evidence":"","severity":0,"suggested_workflow":""}]}',
  "Rules:",
  "- title: short label of the loaded area (e.g. \"Monday intake pile-up\").",
  "- pain: what hurts, in the buyer's own terms.",
  "- bottleneck: the specific constraint or choke point.",
  "- evidence: a short verbatim buyer quote supporting it. Empty string if none.",
  "- severity: 1-5, how heavy this feels.",
  "- suggested_workflow: the ONE workflow most worth a readiness assessment, phrased concretely.",
  "- Order by severity descending. Maximum 6 loads. Empty array when nothing substantive appears.",
  "- Base everything on what the buyer actually said. Never invent."
].join("\n");

function json(statusCode, obj) {
  return { statusCode: statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { ok: false, reason: "method_not_allowed" });

  var key = process.env.ANTHROPIC_API_KEY;
  var body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, reason: "bad_json" }); }
  if (!key) return json(200, { ok: false, reason: "not_configured" });

  var chats = Array.isArray(body.chats) ? body.chats : [];
  if (!chats.length) return json(400, { ok: false, reason: "empty_chats" });

  var parts = chats.slice(0, 10).map(function (c, i) {
    return "--- Conversation " + (i + 1) + (c.name ? " (" + String(c.name).slice(0, 80) + ")" : "") + " ---\n" +
      String(c.transcript || "").slice(0, 6000);
  });
  if (body.profile && body.profile.summary) {
    parts.unshift("Buyer profile: " + String(body.profile.summary).slice(0, 500));
  }
  var input = parts.join("\n\n").slice(0, 40000);
  if (!input.trim()) return json(400, { ok: false, reason: "empty_chats" });

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
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: LOAD_SYSTEM, messages: [{ role: "user", content: input }] })
    });
  } catch (e) { return json(502, { ok: false, reason: "upstream_unreachable" }); }
  if (!resp.ok) return json(502, { ok: false, reason: "upstream_error", status: resp.status });

  var data;
  try { data = await resp.json(); } catch (e) { return json(502, { ok: false, reason: "bad_upstream" }); }
  var text = (data.content || []).map(function (b) { return b.text || ""; }).join("").trim();
  var start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return json(502, { ok: false, reason: "bad_extract" });
  try {
    var parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed.loads)) throw new Error("no loads");
    return json(200, { ok: true, loads: parsed.loads.slice(0, 6) });
  } catch (e) { return json(502, { ok: false, reason: "bad_extract" }); }
};
