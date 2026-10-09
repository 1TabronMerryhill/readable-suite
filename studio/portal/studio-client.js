/* V.I.S.I.O.N. Studio portal shared client + helpers.
   Load order on each portal page:
     1. studio-config.js  (window.STUDIO_SUPABASE_URL / _ANON_KEY / _PORTAL_URL)
     2. https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2
     3. studio-client.js   (this file)
   Exposes window.ST = { supabase, getSession, requireAuth, ensureClient, esc, money,
                         PLANS, planInfo, activeCap, cycleSpots, fmtDate }.
*/
(function () {
  "use strict";

  if (!window.supabase) throw new Error("supabase-js not loaded — include the CDN script before studio-client.js");
  if (!window.STUDIO_SUPABASE_URL || !window.STUDIO_SUPABASE_ANON_KEY)
    throw new Error("Studio config missing — load studio-config.js before studio-client.js");

  var client = window.supabase.createClient(window.STUDIO_SUPABASE_URL, window.STUDIO_SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  async function getSession() {
    var res = await client.auth.getSession();
    if (res.error) throw res.error;
    return res.data.session || null;
  }

  async function requireAuth() {
    var session = await getSession();
    if (!session) {
      window.location.replace("login.html");
      return null;
    }
    return session;
  }

  // Returns the studio_clients row for this user, creating it on first sign-in.
  async function ensureClient(session) {
    var r = await client.from("studio_clients").select("*").eq("user_id", session.user.id).maybeSingle();
    if (r.error) throw r.error;
    if (r.data) return r.data;
    var ins = await client.from("studio_clients").insert({
      user_id: session.user.id,
      business_name: "",
      email: session.user.email,
      plan: "payg"
    }).select().single();
    if (ins.error) throw ins.error;
    return ins.data;
  }

  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  var usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  function money(cents) {
    if (cents === null || cents === undefined) return "—";
    return usd.format(cents / 100);
  }

  var PLANS = {
    presence: { name: "Presence", price: 2500, spots: 4, active: 1 },
    momentum: { name: "Momentum", price: 5000, spots: 8, active: 2 },
    embedded: { name: "Embedded", price: 10000, spots: 16, active: 3 },
    payg: { name: "Pay as you go", price: 297, spots: null, active: null }
  };

  function planInfo(plan) { return PLANS[plan] || PLANS.payg; }

  function fmtDate(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString("en-US", {
        timeZone: "America/Chicago",
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
      });
    } catch (e) { return iso; }
  }

  window.ST = {
    supabase: client, getSession: getSession, requireAuth: requireAuth,
    ensureClient: ensureClient, esc: esc, money: money,
    PLANS: PLANS, planInfo: planInfo, fmtDate: fmtDate
  };
})();
