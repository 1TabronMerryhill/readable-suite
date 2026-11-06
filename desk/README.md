# The Desk — OpOne Capital intelligence desk

The firm's one-screen intelligence desk. Live, not a snapshot.

## What it is

- `index.html` — the Desk page. It loads its data at runtime from
  `/api/desk-data` and refreshes every 60 seconds. If the live endpoint is
  unreachable it falls back to the embedded Nov 6, 2026 snapshot and says so.
- `desk-data.json` — the embedded snapshot fallback (Nov 6, 2026, 13:22 CT).
  The live endpoint returns the same shape with fresh prices.
- `netlify/functions/desk-data.js` — the live data endpoint. Fills and levels
  come from the Nov 6 real executions (static facts, updated when a trade
  happens). Prices come from Yahoo live quotes, server side, no key.
  Gold spot stays on the snapshot until a live spot source lands; the GLD
  position price is live, so its profit and loss is exact.
- `netlify/functions/finnhub-webhook.js` — Finnhub dashboard outbound
  webhook receiver. Needs `FINNHUB_WEBHOOK_SECRET` in the Netlify
  environment. The Finnhub key itself is still 401 until Milly re-enters it
  on the Finnhub dashboard, so Finnhub contributes nothing live yet.
- `netlify/functions/graph-chat.js` — talk to the graph. Groq is the voice,
  for now, model `openai/gpt-oss-120b`. Needs `GROQ_API_KEY` in the Netlify
  environment (same key as the Readable site). Retrieval first, cite the
  node or edge id, or say the graph does not record it.

## Deploy

Netlify site, built from `1TabronMerryhill/readable-suite`, base directory
`desk`, no build command, publish directory `.`. Custom domain (proposed
`desk.tabronmerryhill.com`) is added once Milly gives the word on the name.
Env vars are set in the Netlify dashboard by Milly, never committed.

## The stack

JSON is the data contract. Python runs the graph, the watch, and the feed
transport. Java runs the event bus (`desk-services/`). C++ runs the tick
normalizer (`desk-services/`). The services source lives in
`~/workspace/bobby-axelrod/desk-services/`; the Java bus needs a JDK 11+
host, which Netlify is not. The Desk page never knows which language
produced an event.

## Later

Membership (Phase 5): people pay for access to the intelligence and to use
the agents for their portfolios. The firm's book and a member's book are
separate views from the start. No price set, nothing built for it now.
