/* Readable Station prototype — agent gate.
   POST /api/agent/order (rewritten to /.netlify/functions/agent-order)
   accepts a JSON catering order and routes it through the existing dm_orders
   flow: scheduled -> business confirms (sets total) -> delivered. The
   dm_order_fee trigger computes the 15% fulfillment fee automatically; the
   business net lands in its DayMarket balance on delivery. Nothing here
   duplicates order logic — it only inserts through the same table.

   Auth: x-agent-key header must match AGENT_API_KEY env var.
   Supabase: SUPABASE_SERVICE_KEY env var (service role, never committed,
   set in the Netlify dashboard like AIRTABLE_TOKEN). */

const SUPABASE_URL = "https://evmynxxvyafvnreaudpr.supabase.co";
const REST = SUPABASE_URL + "/rest/v1";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}
const bad = (status, code, message, extra) =>
  json(status, Object.assign({ ok: false, error: code, message }, extra || {}));
const crypto = require("crypto");

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/* Canonical JSON: sorted keys, for a stable inputs hash. */
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v);
}

function sb(serviceKey, method, path, body) {
  return fetch(REST + path, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: "Bearer " + serviceKey,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => {
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: r.status, data };
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "method_not_allowed", "Use POST.");

  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) {
    return bad(
      503,
      "station_not_provisioned",
      "The station is not provisioned on this deploy. The operator must set AGENT_API_KEY."
    );
  }
  const got = event.headers["x-agent-key"] || event.headers["X-Agent-Key"];
  if (!got || got !== apiKey) return bad(401, "unauthorized", "Missing or invalid x-agent-key.");

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    return bad(
      503,
      "station_not_provisioned",
      "The station is not provisioned on this deploy. The operator must set SUPABASE_SERVICE_KEY."
    );
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return bad(400, "invalid_json", "Request body must be valid JSON.");
  }

  const {
    business,
    package: pkg,
    scheduled_for,
    buyer_email,
    contact,
    headcount,
    delivery_address,
    notes,
    idempotency_key,
  } = body || {};

  /* ---- validate ---- */
  const missing = [];
  if (!business) missing.push("business");
  if (!pkg) missing.push("package");
  if (!scheduled_for) missing.push("scheduled_for");
  if (!buyer_email) missing.push("buyer_email");
  if (!contact || !contact.name) missing.push("contact.name");
  if (missing.length) {
    return bad(400, "missing_fields", "Missing required fields: " + missing.join(", ") + ".", {
      required: ["business", "package", "scheduled_for", "buyer_email", "contact.name"],
    });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer_email)) {
    return bad(400, "invalid_buyer_email", "buyer_email must be a valid email address.");
  }
  const when = new Date(scheduled_for);
  if (isNaN(when.getTime())) {
    return bad(400, "invalid_datetime", "scheduled_for must be an ISO 8601 datetime.");
  }
  if (when.getTime() <= Date.now()) {
    return bad(400, "datetime_in_past", "scheduled_for must be in the future.");
  }
  if (headcount !== undefined && !(Number.isInteger(headcount) && headcount > 0)) {
    return bad(400, "invalid_headcount", "headcount must be a positive integer.");
  }

  const inputDoc = {
    business,
    package: pkg,
    scheduled_for,
    buyer_email,
    contact,
    headcount: headcount === undefined ? null : headcount,
    delivery_address: delivery_address || null,
    notes: notes || null,
  };
  const inputsHash = sha256(canonical(inputDoc));

  const q = (m, p, b) => sb(serviceKey, m, p, b);

  /* ---- idempotency: same key + same inputs returns the original order ---- */
  if (idempotency_key) {
    const prev = await q(
      "GET",
      "/dm_agent_verifications?agent_ref=eq." +
        encodeURIComponent(idempotency_key) +
        "&select=id,order_id,inputs_hash,status,created_at"
    );
    if (prev.status === 200 && prev.data && prev.data.length) {
      const rec = prev.data[0];
      if (rec.inputs_hash !== inputsHash) {
        return bad(
          400,
          "idempotency_key_reused",
          "This idempotency key was already used with different inputs."
        );
      }
      const ord = await q(
        "GET",
        "/dm_orders?id=eq." + rec.order_id + "&select=id,status,scheduled_for,headcount,total_cents,payment_status"
      );
      const o = ord.data && ord.data[0];
      if (!o) return bad(500, "order_missing", "Verification record exists but the order is gone.");
      return json(200, {
        ok: true,
        duplicate: true,
        order: {
          id: o.id,
          status: o.status,
          scheduled_for: o.scheduled_for,
          headcount: o.headcount,
          total_cents: o.total_cents,
          payment_status: o.payment_status,
        },
        verification: { id: rec.id, inputs_hash: rec.inputs_hash, recorded_at: rec.created_at },
        next: "No new order was created. This is the original order for your idempotency key.",
      });
    }
  }

  /* ---- lookups ---- */
  const mRes = await q(
    "GET",
    "/dm_members?email=eq." + encodeURIComponent(buyer_email) + "&select=id,email,pass_type,pass_status"
  );
  if (mRes.status !== 200) return bad(500, "lookup_failed", "Buyer lookup failed.");
  const member = mRes.data && mRes.data[0];
  if (!member) {
    return bad(
      404,
      "buyer_not_found",
      "No DayMarket account matches buyer_email. The buyer needs a DayMarket account first: https://daymarket.tabronmerryhill.com/membership.html"
    );
  }

  const bFilter = UUID_RE.test(business)
    ? "id=eq." + business
    : "slug=eq." + encodeURIComponent(business);
  const bRes = await q("GET", "/dm_businesses?" + bFilter + "&select=id,name,slug,status,fee_bps");
  if (bRes.status !== 200) return bad(500, "lookup_failed", "Business lookup failed.");
  const biz = bRes.data && bRes.data[0];
  if (!biz || biz.status !== "active") {
    return bad(404, "business_not_found", "No active DayMarket business matches '" + business + "'.");
  }

  const pRes = await q(
    "GET",
    "/dm_packages?active=eq.true&select=id,business_id,name,base_price_cents,serves_min,serves_max"
  );
  if (pRes.status !== 200) return bad(500, "lookup_failed", "Package lookup failed.");
  const pkgs = pRes.data || [];
  const pack = pkgs.find((p) =>
    UUID_RE.test(pkg)
      ? p.id.toLowerCase() === pkg.toLowerCase()
      : p.name.toLowerCase() === String(pkg).toLowerCase()
  );
  if (!pack) {
    return bad(
      404,
      "package_not_found",
      "No active package matches '" + pkg + "'. See the package menu: https://daymarket.tabronmerryhill.com/packages.html"
    );
  }
  if (pack.business_id && pack.business_id !== biz.id) {
    return bad(400, "package_business_mismatch", "That package does not belong to " + biz.name + ".");
  }

  /* ---- create the order through the existing dm_orders flow ---- */
  const contactBits = ["Agent order via Readable Station."];
  contactBits.push("Contact: " + contact.name);
  if (contact.email) contactBits.push("email " + contact.email);
  if (contact.phone) contactBits.push("phone " + contact.phone);
  if (notes) contactBits.push("Notes: " + notes);

  const orderPayload = {
    org_id: member.id,
    business_id: biz.id,
    package_id: pack.id,
    title: "Agent order: " + pack.name + (headcount ? " for " + headcount : ""),
    scheduled_for: when.toISOString(),
    headcount: headcount === undefined ? null : headcount,
    recurrence: "once",
    status: "scheduled",
    notes: contactBits.join(" "),
    delivery_address: delivery_address || null,
    payment_status: "unpaid",
    /* total_cents stays null until the business confirms and sets the total;
       the dm_order_fee trigger computes fee_cents/net_cents then. */
  };
  const oRes = await q("POST", "/dm_orders", orderPayload);
  if (oRes.status !== 201 || !oRes.data || !oRes.data[0]) {
    return bad(500, "order_create_failed", "Could not create the order.", {
      detail: oRes.data && oRes.data.message ? oRes.data.message : "unknown",
    });
  }
  const order = oRes.data[0];

  /* ---- verification record: the seed of Evals volume ---- */
  const vRes = await q("POST", "/dm_agent_verifications", {
    order_id: order.id,
    endpoint: "/api/agent/order",
    inputs_hash: inputsHash,
    status: order.status,
    agent_ref: idempotency_key || null,
  });
  const ver = vRes.status === 201 && vRes.data && vRes.data[0] ? vRes.data[0] : null;

  return json(201, {
    ok: true,
    duplicate: false,
    order: {
      id: order.id,
      status: order.status,
      business: biz.name,
      package: pack.name,
      scheduled_for: order.scheduled_for,
      headcount: order.headcount,
      total_cents: order.total_cents,
      payment_status: order.payment_status,
    },
    verification: ver
      ? { id: ver.id, inputs_hash: ver.inputs_hash, recorded_at: ver.created_at }
      : { id: null, inputs_hash: inputsHash, recorded_at: null, note: "verification table not migrated yet" },
    next:
      "The business confirms this order in its DayMarket dashboard and sets the total. You will be invoiced; a 15% fulfillment fee is deducted automatically before the business is paid.",
  });
};
