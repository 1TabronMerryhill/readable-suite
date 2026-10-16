/* DayMarket seller system: shared data layer for the seller and owner dashboards.
   Loaded AFTER dm-client.js. Exposes window.SellerData.

   SCHEMA CONTRACT: The main agent owns the Supabase migration and delivers the
   exact table and column names. This file never invents names. Every query reads
   through CONTRACT below. A null value means "not delivered yet": the function
   that needs it throws a ContractError with a clear message, and the dashboard
   pages render an inline notice for that section instead of failing the page.
   When the migration is applied, fill in the nulls and every section lights up.

   VERIFIED_FROM_CODE = column seen in the live readable-suite codebase (not invented).
*/
(function () {
  "use strict";

  if (!window.DM) throw new Error("dm-client.js must load before seller-data.js");

  /* ============ SCHEMA CONTRACT — wired to migration-sellers-v1.sql (applied Oct 16) ============
     Verified against the migration file and live code (station-tools.js,
     migration-orders-v1.sql). CUSTOMER_ID wired Oct 16 after migration v2 added the indexed FK. */
  var CONTRACT = {
    SELLERS_TABLE: "dm_sellers",
    SELLERS_COLS: {
      ID: "id",
      AUTH_USER_ID: "user_id",
      NAME: "name",
      ACTIVE: "status"
    },
    ORDERS_TABLE: "dm_orders",
    ORDERS_COLS: {
      ID: "id",
      BUSINESS_ID: "business_id",
      SELLER_ID: "seller_id",
      CUSTOMER_ID: "customer_id",  /* wired Oct 16: migration v2 applied, indexed FK */
      TOTAL_CENTS: "total_cents",
      STATUS: "status",
      RECURRENCE: "recurrence",
      SCHEDULED_FOR: "scheduled_for",
      TITLE: "title",
      ORDER_TYPE: "order_type",
      CREATED_AT: "created_at"
    },
    CUSTOMERS_TABLE: "dm_customers",
    CUSTOMERS_COLS: {
      ID: "id",
      NAME: "name",
      PHONE: "phone",
      EMAIL: "email",
      BUSINESS_ID: "business_id",
      CONVERTED_BY: "converted_by",
      ORDER_COUNT: "total_orders",
      LAST_ORDER_AT: "last_order_at",
      CREATED_AT: "created_at"
    },
    COMMISSIONS_TABLE: "dm_commissions",
    COMMISSIONS_COLS: {
      ID: "id",
      SELLER_ID: "seller_id",
      ORDER_ID: "order_id",
      BUSINESS_ID: "business_id",
      STREAM: "stream",
      BASIS_CENTS: "basis_cents",
      RATE_BPS: "rate_bps",
      AMOUNT_CENTS: "amount_cents",
      STATUS: "status",
      PAID_AT: "paid_at",
      NOTE: "note",
      CREATED_AT: "created_at"
    },
    BUSINESSES_TABLE: "dm_businesses",
    BUSINESSES_COLS: { ID: "id", NAME: "name" }
  };

  /* ================= contract plumbing ================= */

  function ContractError(missing) {
    this.name = "ContractError";
    this.message = "Schema contract not filled in: " + missing +
      ". Waiting on the migration contract from the main agent.";
  }
  ContractError.prototype = Object.create(Error.prototype);

  function c(table, col, what) {
    var v = CONTRACT[table + "_COLS"][col];
    if (!v) throw new ContractError(table + "." + col + " (" + what + ")");
    return v;
  }
  function table(name) {
    if (!CONTRACT[name + "_TABLE"]) throw new ContractError(name + "_TABLE");
    return CONTRACT[name + "_TABLE"];
  }
  function db() { return window.DM.supabase; }
  function isContractError(e) { return e && e.name === "ContractError"; }

  /* ================= seller identity ================= */

  // Resolve the signed-in user to her seller row. Returns null when not a seller.
  async function getSellerForUser(authUserId) {
    var t = table("SELLERS");
    var id = c("SELLERS", "ID", "seller row id");
    var au = c("SELLERS", "AUTH_USER_ID", "link to supabase auth user");
    var name = c("SELLERS", "NAME", "seller display name");
    var active = CONTRACT.SELLERS_COLS.ACTIVE;
    var q = db().from(t).select([id, au, name].join(",")).eq(au, authUserId).eq(active, "active").maybeSingle();
    var r = await q;
    if (r.error) throw r.error;
    return r.data || null;
  }

  async function getAllSellers() {
    var t = table("SELLERS");
    var id = c("SELLERS", "ID", "seller row id");
    var name = c("SELLERS", "NAME", "seller display name");
    var r = await db().from(t).select([id, name].join(",")).order(name, { ascending: true });
    if (r.error) throw r.error;
    return r.data || [];
  }

  /* ================= sales ================= */

  // Orders this seller converted. Optionally filtered to one business.
  async function getSales(sellerId, businessId) {
    var sellerCol = c("ORDERS", "SELLER_ID", "who sold/converted the order");
    var bizCol = CONTRACT.ORDERS_COLS.BUSINESS_ID;
    var created = CONTRACT.ORDERS_COLS.CREATED_AT || "created_at";
    var total = c("ORDERS", "TOTAL_CENTS", "order total in cents");
    var sel = [sellerCol, bizCol, total,
      CONTRACT.ORDERS_COLS.ID, CONTRACT.ORDERS_COLS.STATUS,
      CONTRACT.ORDERS_COLS.RECURRENCE, CONTRACT.ORDERS_COLS.SCHEDULED_FOR,
      CONTRACT.ORDERS_COLS.TITLE, created,
      "business:" + CONTRACT.BUSINESSES_TABLE + "(name)"
    ].join(",");
    var q = db().from(table("ORDERS")).select(sel).eq(sellerCol, sellerId);
    if (businessId) q = q.eq(bizCol, businessId);
    q = q.order(created, { ascending: false });
    var r = await q;
    if (r.error) throw r.error;
    return r.data || [];
  }

  // Standing / recurring orders this seller brought in (recurrence != "once").
  async function getStandingOrders(sellerId) {
    var all = await getSales(sellerId);
    var recCol = CONTRACT.ORDERS_COLS.RECURRENCE;
    return all.filter(function (o) { return (o[recCol] || "once") !== "once"; });
  }

  /* ================= book of business ================= */

  // Customers this seller converted. Never the master list: always filtered by her id.
  async function getBookCustomers(sellerId) {
    var t = table("CUSTOMERS");
    var cols = CONTRACT.CUSTOMERS_COLS;
    var id = c("CUSTOMERS", "ID", "customer id");
    var name = c("CUSTOMERS", "NAME", "customer name");
    var conv = c("CUSTOMERS", "CONVERTED_BY", "first-touch attribution");
    var sel = [id, name];
    if (cols.PHONE) sel.push(cols.PHONE);
    if (cols.EMAIL) sel.push(cols.EMAIL);
    if (cols.ORDER_COUNT) sel.push(cols.ORDER_COUNT);
    if (cols.BUSINESS_ID) sel.push(cols.BUSINESS_ID + ",business:" + CONTRACT.BUSINESSES_TABLE + "(name)");
    if (cols.CREATED_AT) sel.push(cols.CREATED_AT);
    var r = await db().from(t).select(sel.join(",")).eq(conv, sellerId).order(name, { ascending: true });
    if (r.error) throw r.error;
    return r.data || [];
  }

  // Order history for one customer in the seller's book.
  async function getCustomerOrders(customerId) {
    var custCol = c("ORDERS", "CUSTOMER_ID", "order-to-customer link");
    var created = CONTRACT.ORDERS_COLS.CREATED_AT || "created_at";
    var sel = [custCol, CONTRACT.ORDERS_COLS.ID, CONTRACT.ORDERS_COLS.BUSINESS_ID,
      CONTRACT.ORDERS_COLS.TOTAL_CENTS, CONTRACT.ORDERS_COLS.STATUS,
      CONTRACT.ORDERS_COLS.SCHEDULED_FOR, CONTRACT.ORDERS_COLS.TITLE, created,
      "business:" + CONTRACT.BUSINESSES_TABLE + "(name)"
    ].join(",");
    var r = await db().from(table("ORDERS")).select(sel).eq(custCol, customerId)
      .order(created, { ascending: false });
    if (r.error) throw r.error;
    return r.data || [];
  }

  // Master customer list — OWNER ONLY. Never call from the seller page.
  async function getMasterCustomers() {
    var t = table("CUSTOMERS");
    var cols = CONTRACT.CUSTOMERS_COLS;
    var id = c("CUSTOMERS", "ID", "customer id");
    var sel = [id];
    ["NAME", "PHONE", "EMAIL", "CONVERTED_BY", "ORDER_COUNT", "CREATED_AT"].forEach(function (k) {
      if (cols[k]) sel.push(cols[k]);
    });
    if (cols.BUSINESS_ID) sel.push(cols.BUSINESS_ID + ",business:" + CONTRACT.BUSINESSES_TABLE + "(name)");
    var r = await db().from(t).select(sel.join(","))
      .order(cols.CREATED_AT || id, { ascending: false }).limit(500);
    if (r.error) throw r.error;
    return r.data || [];
  }

  /* ================= commission ledger ================= */

  var STREAM_DAYMARKET = "daymarket_team"; // 15% team split: two rows per team order, 750bps each
  var STREAM_BUSINESS = "business_per_person"; // 15% per person of owner cut, one row per seller at 1500bps

  // Ledger rows for one seller. Optionally filtered to one business.
  async function getLedger(sellerId, businessId) {
    var t = table("COMMISSIONS");
    var cols = CONTRACT.COMMISSIONS_COLS;
    var sellerCol = c("COMMISSIONS", "SELLER_ID", "whose commission it is");
    var streamCol = c("COMMISSIONS", "STREAM", "commission stream");
    var amtCol = c("COMMISSIONS", "AMOUNT_CENTS", "commission amount");
    var statusCol = c("COMMISSIONS", "STATUS", "earned|paid|canceled");
    var sel = [sellerCol, streamCol, amtCol, statusCol];
    if (cols.ID) sel.push(cols.ID);
    if (cols.ORDER_ID) sel.push(cols.ORDER_ID);
    if (cols.BUSINESS_ID) sel.push(cols.BUSINESS_ID + ",business:" + CONTRACT.BUSINESSES_TABLE + "(name)");
    if (cols.PAID_AT) sel.push(cols.PAID_AT);
    if (cols.CREATED_AT) sel.push(cols.CREATED_AT);
    var q = db().from(t).select(sel.join(",")).eq(sellerCol, sellerId);
    if (businessId && cols.BUSINESS_ID) q = q.eq(cols.BUSINESS_ID, businessId);
    if (cols.CREATED_AT) q = q.order(cols.CREATED_AT, { ascending: false });
    var r = await q;
    if (r.error) throw r.error;
    return r.data || [];
  }

  // Full ledger across all sellers — OWNER ONLY. Never call from the seller page.
  async function getFullLedger() {
    var t = table("COMMISSIONS");
    var cols = CONTRACT.COMMISSIONS_COLS;
    var sel = [c("COMMISSIONS", "SELLER_ID"), c("COMMISSIONS", "STREAM"),
      c("COMMISSIONS", "AMOUNT_CENTS"), c("COMMISSIONS", "STATUS")];
    if (cols.ID) sel.push(cols.ID);
    if (cols.ORDER_ID) sel.push(cols.ORDER_ID);
    if (cols.BUSINESS_ID) sel.push(cols.BUSINESS_ID + ",business:" + CONTRACT.BUSINESSES_TABLE + "(name)");
    if (cols.PAID_AT) sel.push(cols.PAID_AT);
    if (cols.CREATED_AT) sel.push(cols.CREATED_AT);
    var q = db().from(t).select(sel.join(","));
    if (cols.CREATED_AT) q = q.order(cols.CREATED_AT, { ascending: false });
    q = q.limit(1000);
    var r = await q;
    if (r.error) throw r.error;
    return r.data || [];
  }

  /* ================= client-side rollups ================= */
  // Everything here is computed from ledger rows. No invented formulas: the
  // backend writes the amounts; the UI only sums earned / paid / owed.

  function rollupLedger(rows) {
    var cols = CONTRACT.COMMISSIONS_COLS;
    var s = cols.STREAM, a = cols.AMOUNT_CENTS, st = cols.STATUS;
    function bucket(stream) {
      var earned = 0, paid = 0;
      rows.forEach(function (r) {
        if (stream && r[s] !== stream) return;
        if (r[st] === "canceled") return;
        var amt = r[a] || 0;
        if (r[st] === "paid") { earned += amt; paid += amt; }
        else { earned += amt; } // 'earned': owed, not yet paid
      });
      return { earned: earned, paid: paid, owed: earned - paid };
    }
    return {
      daymarket: bucket(STREAM_DAYMARKET),
      business: bucket(STREAM_BUSINESS),
      total: bucket(null)
    };
  }

  function revenueByBusiness(sales) {
    var cols = CONTRACT.ORDERS_COLS;
    var byBiz = {};
    sales.forEach(function (o) {
      var bid = o[cols.BUSINESS_ID];
      var bname = (o.business && o.business.name) || "Shop";
      var amt = o[cols.TOTAL_CENTS] || 0;
      if (!byBiz[bid]) byBiz[bid] = { business_id: bid, name: bname, gross: 0, orders: 0 };
      byBiz[bid].gross += amt;
      byBiz[bid].orders += 1;
    });
    return Object.keys(byBiz).map(function (k) { return byBiz[k]; })
      .sort(function (x, y) { return y.gross - x.gross; });
  }

  window.SellerData = {
    CONTRACT: CONTRACT,
    ContractError: ContractError,
    isContractError: isContractError,
    STREAM_DAYMARKET: STREAM_DAYMARKET,
    STREAM_BUSINESS: STREAM_BUSINESS,
    getSellerForUser: getSellerForUser,
    getAllSellers: getAllSellers,
    getSales: getSales,
    getStandingOrders: getStandingOrders,
    getBookCustomers: getBookCustomers,
    getCustomerOrders: getCustomerOrders,
    getMasterCustomers: getMasterCustomers,
    getLedger: getLedger,
    getFullLedger: getFullLedger,
    rollupLedger: rollupLedger,
    revenueByBusiness: revenueByBusiness
  };
})();
