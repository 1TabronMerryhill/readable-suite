/* DayMarket org signup — POST /.netlify/functions/org-signup
 *
 * Public endpoint behind the "Sign up your organization" form. Creates the
 * auth user (if new) and marks their dm_members row as an active
 * organization, so the Organization tab unlocks on their first sign-in.
 *
 * Request:  { org_name, contact_name, email }
 * Response: { ok: true }  — the client then sends the magic link via
 *           supabase.auth.signInWithOtp({ email }).
 *
 * Env: SUPABASE_SERVICE_KEY (service-role; never committed)
 */

const SUPABASE_URL = "https://evmynxxvyafvnreaudpr.supabase.co";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

async function adminFetch(serviceKey, path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    ...opts,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { res, data };
}

async function sbRest(serviceKey, method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { res, text };
}

async function findUserIdByEmail(serviceKey, email) {
  // Small user base: first page of the admin list is enough.
  const { res, data } = await adminFetch(serviceKey, "/users?per_page=100");
  if (!res.ok) return null;
  const users = (data && data.users) || data || [];
  const hit = users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
  return hit ? hit.id : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return json(500, { ok: false, error: "not_configured" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad_json" }); }

  const orgName = (body.org_name || "").trim().slice(0, 120);
  const contactName = (body.contact_name || "").trim().slice(0, 120);
  const email = (body.email || "").trim().toLowerCase().slice(0, 200);
  if (!orgName || !contactName || !EMAIL_RE.test(email)) {
    return json(400, { ok: false, error: "bad_input" });
  }

  // 1. Ensure the auth user exists.
  let userId = null;
  const created = await adminFetch(serviceKey, "/users", {
    method: "POST",
    body: JSON.stringify({
      email,
      email_confirm: true,
      user_metadata: { org_name: orgName, contact_name: contactName, signup: "org" },
    }),
  });
  if (created.res.ok && created.data && created.data.id) {
    userId = created.data.id;
  } else {
    const msg = JSON.stringify(created.data || "");
    if (/already been registered|already exists|duplicate/i.test(msg)) {
      userId = await findUserIdByEmail(serviceKey, email);
    }
  }
  if (!userId) return json(500, { ok: false, error: "user_failed" });

  // 2. Mark the member row as an active organization.
  const member = {
    id: userId,
    email,
    full_name: `${contactName} — ${orgName}`,
    pass_type: "organization",
    pass_status: "active",
  };
  const up = await sbRest(serviceKey, "POST", "/dm_members?on_conflict=id", member);
  if (!up.res.ok) return json(500, { ok: false, error: "member_failed" });

  return json(200, { ok: true });
};
