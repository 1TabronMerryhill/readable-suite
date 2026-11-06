// desk-data.js — the Desk live data endpoint.
// GET /api/desk-data returns the Desk snapshot with LIVE prices.
// Fills and levels are the Nov 6, 2026 real executions (static facts,
// updated in this file when a trade happens). Prices come from Yahoo
// Finance v8 chart (the same endpoint bobby_trade.py uses), server side,
// no key. Gold spot stays on the Nov 6 13:16 CT snapshot until a live spot
// source lands; the GLD position price is live, so its profit and loss is
// exact. If any quote fails, the endpoint returns 502 and the page falls
// back to its embedded snapshot. Never serve a fill price as a last price.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36";
const SYMBOLS = ["MU", "QCOM", "GLD", "AMD", "DUOL"];
const CASH = 31.25;
const GOLD = {
  spot: 4084.10, entry: 4040, target: 4090, stop: 4000,
  kill: "daily close below spot $3,970",
  as_of: "13:16 CT Nov 6, 2026 (Yahoo snapshot)",
};

const FILLS = [
  { symbol: "MU", qty: 0.02258, fill: 691.7347, stop: 656.39, target: 740, target2: 780,
    kill: "break below $656.39; weekly close below $600 kills the longer thesis",
    order_id: "6aee297b-80a8-43e4-822c-893ce54dc96c", filled_at: "2026-11-06T13:24:00-06:00" },
  { symbol: "QCOM", qty: 0.093966, fill: 166.23, stop: 156.75, target: 172, target2: 180,
    kill: "$152.50 or an Apple modem headline",
    order_id: "6aee297f-a42b-40d3-bf15-cbbe2ba573e5", filled_at: "2026-11-06T13:24:00-06:00" },
  { symbol: "GLD", qty: 0.0419, fill: 372.7899, stop: 368.16, target: 376.39, target2: null,
    kill: "daily close below spot $3,970",
    order_id: "6aee2984-f2e0-474f-9720-70b9fb7e0d14", filled_at: "2026-11-06T13:24:00-06:00" },
];

const CONDITIONALS = [
  { symbol: "AMD", condition: "pullback to $436.50", stop: 404.40, targets: [460, 476] },
  { symbol: "DUOL", condition: "reclaim above $161.27", stop: 150, targets: [175, 184] },
];

async function yahooPrice(sym) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/"
    + encodeURIComponent(sym) + "?interval=1d&range=1d";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error("yahoo " + res.status + " for " + sym);
  const d = await res.json();
  const meta = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
  const px = meta && meta.regularMarketPrice;
  if (typeof px !== "number" || !isFinite(px)) throw new Error("no price for " + sym);
  return px;
}

function round2(n) { return Math.round(n * 100) / 100; }

exports.handler = async () => {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  let prices;
  try {
    const vals = await Promise.all(SYMBOLS.map(yahooPrice));
    prices = Object.fromEntries(SYMBOLS.map((s, i) => [s, vals[i]]));
  } catch (e) {
    return { statusCode: 502, headers,
      body: JSON.stringify({ error: "quote_failed", detail: String((e && e.message) || e) }) };
  }

  const positions = FILLS.map((f) => {
    const last = prices[f.symbol];
    return { symbol: f.symbol, qty: f.qty, fill: f.fill, last,
      pnl: round2((last - f.fill) * f.qty), stop: f.stop, target: f.target,
      target2: f.target2, kill: f.kill, order_id: f.order_id, filled_at: f.filled_at };
  });
  const equity = round2(positions.reduce((s, p) => s + p.last * p.qty, 0));
  const total = round2(equity + CASH);
  const gld = prices.GLD;
  const attention = gld >= 375.39
    ? "Gold is within $1 of its GLD target $376.39 (spot $4,090). This needs you."
    : gld <= 369.16
      ? "Gold is within $1 of its GLD stop $368.16 (spot $4,000). This needs you."
      : "Nothing needs you right now.";

  return { statusCode: 200, headers, body: JSON.stringify({
    generated: new Date().toISOString(),
    firm: "OpOne Capital",
    feed: "yahoo-live",
    book: { real: { total, cash: CASH, equity, positions: 3 },
            paper: { total: 105.44, cash: 105.44, open: 0, closed: 0 } },
    attention,
    positions,
    conditionals: CONDITIONALS.map((c) => ({ ...c, last: prices[c.symbol] })),
    gold: { ...GOLD },
    quotes_as_of: "live, fetched now from Yahoo Finance v8 chart; gold spot as of " + GOLD.as_of,
  }) };
};
