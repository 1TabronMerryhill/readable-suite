/* verify-workflow-subscription: is this email an active Workflow subscriber?
   Called by workflow.tabronmerryhill.com gated pages after the reader enters
   their email. Follows the verify-payment pattern.

   POST { email } -> { active: bool, tier: "publication"|"premium"|null,
                       trial: bool, reports: [names] }
   Reads the List Subscribers table in the SPIN base with AIRTABLE_TOKEN
   (already set on this site). A reconciliation job keeps paid/trial/report
   rows current from Stripe. */

"use strict";

var AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN || "";
var BASE = "appHDR9CU6WjHYZdy";
var TABLE = "tblQGrrB2GN1rjxi2";
var FLD_EMAIL = "fldWWhc7Io5txRY0N";
var FLD_STATUS = "fldoP4G0fD1a9M6CF";
var FLD_NOTES = "fldYeGmLeFIEL7QZp";

var ALLOWED_ORIGINS = [
  "https://workflow.tabronmerryhill.com",
  "https://workflow-doorway.netlify.app",
  "https://readable.tabronmerryhill.com"
];

function cors(origin) {
  var allow = ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[0];
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

/* Notes carry a machine line: [workflow] state=paid tier=premium stripe=cus_xxx trial_ends=2026-11-13 reports=Q4-2026 */
function parseWorkflowLine(notes) {
  var out = {};
  if (!notes) return out;
  var m = String(notes).match(/\[workflow\]([^\n]*)/);
  if (!m) return out;
  m[1].trim().split(/\s+/).forEach(function (pair) {
    var kv = pair.split("=");
    if (kv.length === 2) out[kv[0]] = kv[1];
  });
  return out;
}

exports.handler = async function (event) {
  var headers = cors(event.headers && (event.headers.origin || event.headers.Origin));
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: headers, body: "{}" };
  }
  var email = "";
  try { email = (JSON.parse(event.body || "{}").email || "").toLowerCase().trim(); } catch (e) {}
  var denied = { active: false, tier: null, trial: false, reports: [] };
  if (!email || !AIRTABLE_TOKEN) {
    return { statusCode: 200, headers: headers, body: JSON.stringify(denied) };
  }
  try {
    var formula = "LOWER({" + "Email" + "})='" + email.replace(/'/g, "\\'") + "'";
    var url = "https://api.airtable.com/v0/" + BASE + "/" + TABLE +
      "?filterByFormula=" + encodeURIComponent(formula) + "&maxRecords=1";
    var res = await fetch(url, { headers: { Authorization: "Bearer " + AIRTABLE_TOKEN } });
    if (!res.ok) throw new Error("airtable read failed: " + res.status);
    var data = await res.json();
    var rec = (data.records && data.records[0]) || null;
    if (!rec) {
      return { statusCode: 200, headers: headers, body: JSON.stringify(denied) };
    }
    var fields = rec.fields || {};
    var meta = parseWorkflowLine(fields[FLD_NOTES] || fields["Notes"] || "");
    /* Machine line format: [workflow] state=paid|trial tier=publication|premium
       trial_ends=YYYY-MM-DD stripe=cus_xxx reports=a,b */
    var today = new Date().toISOString().slice(0, 10);
    var ok = false, tier = null, trial = false;
    if (meta.state === "paid" && (meta.tier === "premium" || meta.tier === "publication")) {
      ok = true; tier = meta.tier;
    } else if (meta.state === "trial" && meta.trial_ends && meta.trial_ends >= today) {
      ok = true; tier = meta.tier === "premium" ? "premium" : "publication"; trial = true;
    }
    var reports = [];
    if (meta.reports) reports = meta.reports.split(",").filter(Boolean);
    return {
      statusCode: 200, headers: headers,
      body: JSON.stringify({ active: ok, tier: tier, trial: trial, reports: reports })
    };
  } catch (e) {
    console.error("verify-workflow-subscription failed:", e.message);
    return { statusCode: 200, headers: headers, body: JSON.stringify(denied) };
  }
};
