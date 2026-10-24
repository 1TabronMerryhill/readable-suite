/* DayMarket org invite — POST /.netlify/functions/org-invite
 *
 * Business-authed: the caller must own business_id (or be the operator).
 * Creates (or finds) the org's auth user, marks the dm_members row as an
 * organization with pass_status 'inactive' (ordering unlocks when the
 * $49/mo membership is paid; an already-active org is never downgraded),
 * opens the calendar link, and returns a single-use expiring magic link
 * for the business to forward to the org. The business holds that link,
 * so the org should sign in promptly; inviting again issues a fresh one.
 *
 * Request:  { business_id, org_name, contact_name, email }
 * Response: { ok: true, org_id, join_id, already_linked, magic_link }
 *
 * Env: SUPABASE_SERVICE_KEY (service-role; never committed)
 */

const SUPABASE_URL = "https://evmynxxvyafvnreaudpr.supabase.co";
const OPERATORS = ["tabronmerryhill@gmail.com", "tabron@tabronmerryhill.com"];
const ACCOUNT_URL = "https://daymarket.tabronmerryhill.com/account/";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

async function adminFetch(serviceKey, path, opts) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    ...(opts || {}),
    headers: {
      apikey: serviceKey,
      Authorization: "Bearer " + serviceKey,
      "Content-Type": "application/json",
      ...((opts && opts.headers) || {}),
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
      Authorization: "Bearer " + serviceKey,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { res, text, data };
}

async function getCaller(token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: token, Authorization: "Bearer " + token },
  });
  if (!res.ok) return null;
  return res.json();
}

async function findUserIdByEmail(serviceKey, email) {
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

  const auth = (event.headers.authorization || event.headers.Authorization || "");
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { ok: false, error: "sign_in_required" });
  const caller = await getCaller(token);
  if (!caller || !caller.id) return json(401, { ok: false, error: "sign_in_required" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad_json" }); }
  const businessId = String(body.business_id || "");
  const orgName = String(body.org_name || "").trim().slice(0, 120);
  const contactName = String(body.contact_name || "").trim().slice(0, 120);
  const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
  if (!businessId || !orgName || !contactName || !EMAIL_RE.test(email)) {
    return json(400, { ok: false, error: "bad_input" });
  }

  // Caller must own the business, or be the operator.
  const biz = await sbRest(serviceKey, "GET", `/dm_businesses?id=eq.${businessId}&select=id,owner_id`);
  const bizRow = biz.data && biz.data[0];
  const isOperator = OPERATORS.includes((caller.email || "").toLowerCase());
  if (!bizRow || (bizRow.owner_id !== caller.id && !isOperator)) {
    return json(403, { ok: false, error: "not_business_owner" });
  }

  // 1. Ensure the auth user exists.
  let userId = await findUserIdByEmail(serviceKey, email);
  if (!userId) {
    const created = await adminFetch(serviceKey, "/users", {
      method: "POST",
      body: JSON.stringify({
        email,
        email_confirm: true,
        user_metadata: { org_name: orgName, contact_name: contactName, signup: "org_invite" },
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
  }
  if (!userId) return json(500, { ok: false, error: "user_failed" });

  // 2. Mark the member row as an organization. Never downgrade an active org.
  const existing = await sbRest(serviceKey, "GET", `/dm_members?id=eq.${userId}&select=id,pass_status`);
  const existingRow = existing.data && existing.data[0];
  if (!existingRow) {
    const up = await sbRest(serviceKey, "POST", "/dm_members", {
      id: userId, email, full_name: contactName, org_name: orgName,
      pass_type: "organization", pass_status: "inactive",
    });
    if (!up.res.ok) return json(500, { ok: false, error: "member_failed" });
  } else if (existingRow.pass_status !== "active") {
    const up = await sbRest(serviceKey, "PATCH", `/dm_members?id=eq.${userId}`, {
      email, full_name: contactName, org_name: orgName,
      pass_type: "organization", pass_status: "inactive",
    });
    if (!up.res.ok) return json(500, { ok: false, error: "member_failed" });
  }

  // 3. Open the calendar link (idempotent: reuse an active link).
  let joinId = null;
  let alreadyLinked = false;
  const link = await sbRest(serviceKey, "GET",
    `/dm_org_calendars?org_id=eq.${userId}&business_id=eq.${businessId}&status=eq.active&select=id`);
  if (link.data && link.data[0]) {
    joinId = link.data[0].id;
    alreadyLinked = true;
  } else {
    const ins = await sbRest(serviceKey, "POST", "/dm_org_calendars", {
      org_id: userId, business_id: businessId, status: "active", source: "business_invite",
    });
    if (!ins.res.ok) return json(500, { ok: false, error: "link_failed" });
    joinId = ins.data && ins.data[0] && ins.data[0].id;
  }

  // 4. Single-use expiring magic link for the business to forward.
  const ml = await adminFetch(serviceKey, "/generate_link", {
    method: "POST",
    body: JSON.stringify({
      type: "magiclink", email,
      options: { redirect_to: ACCOUNT_URL },
    }),
  });
  const magicLink = (ml.data && (ml.data.action_link || (ml.data.properties && ml.data.properties.action_link))) || null;
  if (!magicLink) return json(500, { ok: false, error: "link_failed" });

  return json(200, { ok: true, org_id: userId, join_id: joinId, already_linked: alreadyLinked, magic_link: magicLink });
};
