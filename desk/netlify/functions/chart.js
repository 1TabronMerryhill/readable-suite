// chart.js — the Newsroom chart endpoint.
// GET /api/chart?symbol=MU&range=3mo&interval=1d
// Returns OHLC candles plus volume from the Yahoo v8 chart endpoint,
// the same endpoint and browser UA desk-data.js uses, with SMA 20,
// SMA 50, and RSI 14 computed server side and aligned to the candles.
// Cache-Control: no-store. On any quote failure the endpoint returns
// 502 {error:"quote_failed"} so the page never renders fake candles.
// A candle is never built from a fill price or a stale price: only
// Yahoo candles are returned, and entries with no finite close are
// dropped. BRK.B is sent to Yahoo as BRK-B; the response carries the
// symbol as requested.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36";
const RANGES = ["1mo", "3mo", "6mo", "1y", "2y", "5y"];
const INTERVALS = ["1d", "1wk", "1mo"];

function round(n, d) {
  if (typeof n !== "number" || !isFinite(n)) return null;
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

// Simple moving average over closes. Null until the window is full.
function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = round(sum / period, 4);
  }
  return out;
}

// RSI 14, Wilder smoothing. First value lands at index 14, from the
// simple average of the first 14 gains and losses. Null before that.
function rsi(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch > 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : round(100 - 100 / (1 + avgGain / avgLoss), 2);
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : round(100 - 100 / (1 + avgGain / avgLoss), 2);
  }
  return out;
}

async function yahooCandles(sym, range, interval) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/"
    + encodeURIComponent(sym) + "?interval=" + interval + "&range=" + range;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error("yahoo " + res.status + " for " + sym);
  const d = await res.json();
  const result = d && d.chart && d.chart.result && d.chart.result[0];
  if (!result) throw new Error("no result for " + sym);
  const ts = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const opens = q.open || [], highs = q.high || [], lows = q.low || [],
    closes = q.close || [], vols = q.volume || [];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c !== "number" || !isFinite(c)) continue;
    const o = (typeof opens[i] === "number" && isFinite(opens[i])) ? opens[i] : c;
    const h = (typeof highs[i] === "number" && isFinite(highs[i])) ? highs[i] : Math.max(o, c);
    const l = (typeof lows[i] === "number" && isFinite(lows[i])) ? lows[i] : Math.min(o, c);
    const v = (typeof vols[i] === "number" && isFinite(vols[i])) ? vols[i] : 0;
    candles.push({ t: ts[i], o: round(o, 4), h: round(h, 4), l: round(l, 4), c: round(c, 4), v });
  }
  if (!candles.length) throw new Error("no candles for " + sym);
  const meta = result.meta || {};
  return {
    candles,
    meta: {
      fiftyTwoWeekHigh: round(meta.fiftyTwoWeekHigh, 4),
      fiftyTwoWeekLow: round(meta.fiftyTwoWeekLow, 4),
      regularMarketPrice: round(meta.regularMarketPrice, 4),
      currency: meta.currency || null,
      exchangeName: meta.exchangeName || null,
    },
  };
}

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const fail = (detail) => ({ statusCode: 502, headers,
    body: JSON.stringify({ error: "quote_failed", detail: String(detail || "") }) });
  try {
    const qs = (event && event.queryStringParameters) || {};
    const rawSymbol = String(qs.symbol || "MU").trim().toUpperCase();
    if (!/^[A-Z0-9.\-^]{1,12}$/.test(rawSymbol)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "bad_symbol" }) };
    }
    const range = RANGES.indexOf(qs.range) >= 0 ? qs.range : "3mo";
    const interval = INTERVALS.indexOf(qs.interval) >= 0 ? qs.interval : "1d";
    // Yahoo takes BRK-B, not BRK.B. The response keeps the requested symbol.
    const yahooSymbol = rawSymbol.replace(".", "-");
    const { candles, meta } = await yahooCandles(yahooSymbol, range, interval);
    const closes = candles.map((c) => c.c);
    return { statusCode: 200, headers, body: JSON.stringify({
      symbol: rawSymbol,
      range,
      interval,
      source: "Yahoo Finance v8 chart",
      as_of: new Date().toISOString(),
      candles,
      sma20: sma(closes, 20),
      sma50: sma(closes, 50),
      rsi14: rsi(closes, 14),
      meta,
    }) };
  } catch (e) {
    return fail(e && e.message ? e.message : e);
  }
};
