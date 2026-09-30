/* Readable suite — governed intake function.
   Accepts POST JSON {form_id, fields} and creates one record in Airtable.
   Most forms write to the Readable base (appio2HRVGqJEzZeP); "subscribe"
   writes to List Subscribers in the SPIN base (appHDR9CU6WjHYZdy).
   Auth: Airtable personal access token in env AIRTABLE_TOKEN (never logged). */

const BASE_ID = "appio2HRVGqJEzZeP";
const AIRTABLE_API = "https://api.airtable.com/v0";

/* Per-form table + field mappings. clientKey -> airtable field id.
   Special clientKeys handled in buildFields():
   __static_*  -> fixed value written as-is
   __now       -> ISO timestamp                        */
const FORMS = {
  "readiness-apply": {
    table: "tblhb98tLxJNbApBs", // Partnership Opportunities
    map: {
      organization_name: "fldfG9B8IWEBQ1POR",
      organization_type: "fldbceSoaarsvIw8Z",
      contact_email: "fldjyLuOWlKHKu9m2",
      contact_phone: "fldgrQjhFGPwhHGv8",
      buyer_website: "fldu9cfY5ari0X0lO",
      city_region: "fldEwmA6DwVCLIMP4",
      capacity_pressures: "fldp2NDjP762PZJzO",
      priority_workflows: "fld0Zds610PqIVYAS",
      desired_outcomes: "fldkEAaLVHhTf1AbR", // multipleSelects — array
      current_ai_use: "fldWEOHGmPetJJ9zD",
      stakeholders: "fldjtUOarfBbNjJeZ",
      discovery_timing: "fld9TBHRSUMSjkxNk",
      budget_position: "fld9kdSLcZ44IpnAR",
    },
    statics: { fldlRNkUDH0r4OpG7: "Website — Practical AI Readiness" }, // Intake Source
    timestamps: ["fldWOyIHYEjy9DCAa"], // Submitted At
    required: ["organization_name", "contact_email"],
  },
  "cohorts-start": {
    table: "tblidJoZaKkMnpteN", // Community AI Partners
    map: {
      organization_name: "fldWY1qVi4pbSdta2",
      organization_type: "fldt9iafA1sIautkT",
      primary_contact: "fldfHA3HoRegL8Iof",
      contact_email: "fldrXMVM8itWycrIg",
      contact_phone: "fldxYcfxXpN2XB7Qt",
      website_url: "fldEmvG96A9NBuoRx",
      city_region: "fldiMLrBwfnjcaKHm",
      estimated_participants: "fldGunG7CahYLmARm",
      accessibility_needs: "fld9RvoiYfeKHFUmH",
      language_needs: "fldrkc2EbIDmQOq4K",
      cohort_request_model: "fld5WXWsZcf7KAbb8",
      intended_participant_group: "fldmSZIArqo5nWws3",
      desired_start_window: "fldGDUbjpgx4RS9zo",
      organization_cohort_goal: "fldFloe0wTlcVgJMJ",
      cohort_request_consent: "fldGaH4OZhirpwUVm", // checkbox
      constraints: "fldRd4e2mLx7ArIe6", // Partner Requirements / Constraints
    },
    required: ["organization_name", "primary_contact", "contact_email"],
  },
  "academy-apply": {
    table: "tblDsnZDKnJZjCUtt", // Academy Enrollments
    map: {
      organization_name: "fldn4Q5YGwHxi6by",
      contact_name: "fldqvlJlUAoFUVGHn",
      email: "fldk0IA7WPjmW3YiF",
      phone: "fldJH2YZCefGDfFvi",
      website_url: "fldra2jsJEen3Buo0",
      city_region: "fldqZwP4NEe0ZSZpn",
      industry: "fldwEFh5sww0zN0Pd",
      primary_products_services: "fld0MTqnfu0LZxj17",
      primary_public_content: "flddYboOFJXOSY4No",
      primary_discoverability_concern: "fldxUheMVFtvk0OJC",
      desired_ai_representation: "fld6J1podLtCXjC3m",
      founding_100: "fldmGPJFS8zWkpITG", // checkbox
      sponsored_seat: "fld4t6J6uJ9KQYPVw", // checkbox
      trust_audit_interest: "fldtyQnZ1ndmqxdrZ", // checkbox
    },
    statics: { fldU96j9LWwClFrXD: "Readable Academy", fldUao6Wp2Oc2HvdT: "New Enrollment" }, // Entry Path, Enrollment Status
    required: ["organization_name", "contact_name", "email"],
  },
  "business-systems": {
    table: "tblyfZXpRoR90YENt", // Business Systems Requests
    map: {
      submitted_problem: "fldGZxcTCpcZU7O1W",
      desired_outcome: "fldM5Ocs2Js9G2pPC",
      why_now: "fldXUzbJi1L54VUbp",
      current_workaround: "fld36aJCG5xymo3Zj",
      evidence_links: "fldHYg0WU5SM1Lnvk",
    },
    statics: { fldzeI2YhQbplji0: "Queued" }, // Request Status
    timestamps: ["fld3nQUy7Oiul8XLG"], // Submitted At
    required: ["business_name", "contact_email", "submitted_problem"],
    // Business name + contact email have no dedicated fields in this table:
    // title is composed from business name + date, contact goes to Next Action.
    compose: {
      titleField: "fldrTfl6UDrq9u4Zo", // Request (title)
      titleFrom: "business_name",
      contactField: "fldvkf3V8oebrLVCn", // Next Action
      contactFrom: "contact_email",
    },
  },
  "partner-intake": {
    table: "tblhb98tLxJNbApBs", // Partnership Opportunities
    map: {
      organization_name: "fldrFsPCKwN6HGz45", // Buyer Organization
      organization_type: "fldfG9B8IWEBQ1POR", // Buyer Organization Type
      contact_email: "fldjyLuOWlKHKu9m2", // Contact Email
      contact_phone: "fldgrQjhFGPwhHGv8", // Contact Phone
      buyer_website: "fldu9cfY5ari0X0lO", // Buyer Website
      city_region: "fldEwmA6DwVCLIMP4", // City / Region
      workflow_description: "fld0Zds610PqIVYAS", // Priority Workflows
      affected_users: "fldjtUOarfBbNjJeZ", // Stakeholders to Involve
      current_evidence: "fldp2NDjP762PZJzO", // Capacity Pressures
      travel_need: "fld4yc3y8bF9rh0Pl", // Travel Condition
      consent: "fld3HND1uWKf6p1wA", // Website Consent (checkbox)
    },
    statics: {
      fld9GokGyaso2EXzm: "Identified", // Opportunity Status
      fldbceSoaarsvIw8Z: "Field Network", // Opportunity Type
      fldlRNkUDH0r4OpG7: "Website — Partner Intake", // Intake Source
    },
    timestamps: ["fldWOyIHYEjy9DCAa"], // Submitted At
    required: ["organization_name", "contact_name", "contact_email", "workflow_description"],
    requiredTrue: ["consent"],
    // Contact name, desired outcome, urgency, confidentiality, and rights have no
    // dedicated fields: title is composed from org + date, the rest goes to notes.
    compose: {
      titleField: "fld0WF9hJ6zWCupx0", // Partnership Opportunity (title)
      titleFrom: "organization_name",
      titlePrefix: "Partner Intake",
      notesField: "fldVvP3mlv2sitdEO", // Human Qualification Notes
      notes: [
        { key: "contact_name", label: "Contact" },
        { key: "contact_email", label: "Email" },
        { key: "desired_outcome", label: "Desired outcome" },
        { key: "urgency", label: "Urgency" },
        { key: "confidentiality_needs", label: "Confidentiality" },
        { key: "rights_notes", label: "Rights notes" },
      ],
    },
  },
  "subscribe": {
    base: "appHDR9CU6WjHYZdy", // SPIN Operating Control Center (not the Readable base)
    table: "tblQGrrB2GN1rjxi2", // List Subscribers
    map: {
      name: "fldRp6gAAxtaXE0IK", // Name
      email: "fldWWhc7Io5txRY0N", // Email
    },
    statics: {
      fldGHMLNQJVSeRJIy: "Website", // Source
      fldoP4G0fD1a9M6CF: "Active", // Status
    },
    timestamps: ["fldVP7k4OWKzxeUYx"], // Consent Date
    required: ["email"],
  },
};

function bad(status, message) {
  return { statusCode: status, body: JSON.stringify({ ok: false, error: message }) };
}

function asBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["true", "on", "1", "yes"].includes(v.toLowerCase());
  return false;
}

function buildFields(def, fields) {
  const out = {};
  for (const [key, fieldId] of Object.entries(def.map)) {
    let v = fields[key];
    if (v === undefined || v === null || v === "") continue;
    // checkbox fields
    if (key === "cohort_request_consent" || key === "founding_100" || key === "sponsored_seat" || key === "trust_audit_interest" || key === "consent") {
      out[fieldId] = asBool(v);
    } else if (key === "estimated_participants") {
      const n = parseInt(v, 10);
      if (!Number.isNaN(n)) out[fieldId] = n;
    } else if (key === "desired_outcomes") {
      out[fieldId] = Array.isArray(v) ? v : [v];
    } else {
      out[fieldId] = typeof v === "string" ? v.trim() : v;
    }
  }
  for (const [fieldId, value] of Object.entries(def.statics || {})) out[fieldId] = value;
  const now = new Date().toISOString();
  for (const fieldId of def.timestamps || []) out[fieldId] = now;
  if (def.compose) {
    const name = (fields[def.compose.titleFrom] || "Website inquiry").toString().trim();
    const prefix = def.compose.titlePrefix ? def.compose.titlePrefix + " — " : "";
    out[def.compose.titleField] = `${prefix}${name} — ${now.slice(0, 10)}`;
    if (def.compose.contactField) {
      const email = (fields[def.compose.contactFrom] || "").toString().trim();
      if (email) out[def.compose.contactField] = `Contact: ${email} — awaiting human review.`;
    }
    if (def.compose.notesField && Array.isArray(def.compose.notes)) {
      const lines = def.compose.notes
        .map((n) => {
          const v = (fields[n.key] || "").toString().trim();
          return v ? `${n.label}: ${v}` : "";
        })
        .filter(Boolean);
      if (lines.length) out[def.compose.notesField] = lines.join("\n");
    }
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "Method not allowed");

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return bad(400, "Invalid JSON");
  }

  const { form_id, fields } = body || {};
  const def = FORMS[form_id];
  if (!def) return bad(400, "Unknown form"); // allowlist enforced
  if (!fields || typeof fields !== "object") return bad(400, "Missing fields");

  for (const key of def.required || []) {
    const v = fields[key];
    if (v === undefined || v === null || String(v).trim() === "") {
      return bad(400, `Missing required field: ${key}`);
    }
  }
  for (const key of def.requiredTrue || []) {
    if (!asBool(fields[key])) return bad(400, `Required confirmation missing: ${key}`);
  }
  if (fields.contact_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(fields.contact_email))) {
    return bad(400, "Invalid email address");
  }
  if (fields.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(fields.email))) {
    return bad(400, "Invalid email address");
  }

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) return bad(500, "Intake is not configured yet");

  const airtableFields = buildFields(def, fields);
  if (Object.keys(airtableFields).length === 0) return bad(400, "No usable fields");

  let resp;
  try {
    resp = await fetch(`${AIRTABLE_API}/${def.base || BASE_ID}/${def.table}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`, // never logged
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields: airtableFields }),
    });
  } catch (e) {
    return bad(502, "Could not reach the intake backend");
  }

  if (!resp.ok) {
    return bad(502, "Intake backend rejected the submission");
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
