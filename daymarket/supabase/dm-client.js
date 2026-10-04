/* DayMarket shared Supabase client + helpers.
   Load order on each account page:
     1. ../supabase/dm-config.js        (window.DM_SUPABASE_URL / _ANON_KEY / _ACCOUNT_URL)
     2. https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2
     3. ../supabase/dm-client.js        (this file)
   The anon key is client-public by design; RLS protects the data.
   Exposes window.DM = { supabase, getSession, requireAuth, upsertMember, money, genCode, esc }.
*/
(function () {
  "use strict";

  if (!window.supabase) throw new Error("supabase-js not loaded — include the CDN script before dm-client.js");
  if (!window.DM_SUPABASE_URL || !window.DM_SUPABASE_ANON_KEY)
    throw new Error("DayMarket config missing — load dm-config.js before dm-client.js");

  var client = window.supabase.createClient(window.DM_SUPABASE_URL, window.DM_SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Parses the magic-link hash fragment on page load automatically.
      detectSessionInUrl: true
    }
  });

  async function getSession() {
    var res = await client.auth.getSession();
    if (res.error) throw res.error;
    return res.data.session || null;
  }

  // Returns the session, or bounces to the login page when signed out.
  async function requireAuth() {
    var session = await getSession();
    if (!session) {
      window.location.replace("login.html");
      return null;
    }
    return session;
  }

  // Creates the dm_members row on first sign-in; updates email on later ones.
  async function upsertMember(session) {
    var res = await client
      .from("dm_members")
      .upsert({ id: session.user.id, email: session.user.email }, { onConflict: "id" });
    if (res.error) throw res.error;
  }

  var usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  function money(cents) {
    if (cents === null || cents === undefined) return "—";
    return usd.format(cents / 100);
  }

  var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  function genCode() {
    var s = "";
    for (var i = 0; i < 8; i++) {
      var r;
      if (window.crypto && window.crypto.getRandomValues) {
        var b = new Uint8Array(1);
        window.crypto.getRandomValues(b);
        r = b[0];
      } else {
        r = Math.floor(Math.random() * 256);
      }
      s += CODE_ALPHABET[r % CODE_ALPHABET.length];
    }
    return "DM-" + s;
  }

  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  window.DM = {
    supabase: client,
    getSession: getSession,
    requireAuth: requireAuth,
    upsertMember: upsertMember,
    money: money,
    genCode: genCode,
    esc: esc
  };
})();
