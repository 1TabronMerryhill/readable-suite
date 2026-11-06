# OpOne Capital Desk feed pipeline (Railway service)

The backend plumbing for The Desk (spec:
`~/workspace/bobby-axelrod/intelligence-desk-spec.md`, section 7).
Three languages, three jobs, one pipeline. Python moves the data, C++
translates it, Java keeps the record and serves it.

**This repo copy is the deploy source.** The working copy at
`~/workspace/bobby-axelrod/desk-services/` is the dev and proof copy
(see its `proof/PROOF.md` for the sandbox end to end proof). Changes
that ship go here, in `readable-suite/desk-services/`, and deploy from
GitHub.

## The pipeline

```text
Finnhub websocket (wss://ws.finnhub.io, subscribe per symbol)
  v
Python transport: python/finnhub_ws.py (Railway copy)
  |  prints raw {"type":"trade","data":[...]} lines
  v
C++ tick normalizer: tick-normalizer (compiled in the image)
  |  parses trade messages, emits Desk quote.tick JSON lines
  v
Python feeder: python/feeder.py
  |  POSTs each tick to the bus POST /ingest (Bearer token)
  v
Java event bus: java EventBus
  |  validates each event against the contract
  |  appends valid events to data/events.jsonl
  |  serves the log over SSE, plus GET /snapshot and POST /ingest
  v
Python consumer: python/consumer.py (every 30s)
  |  folds the latest ticks into data/desk-data-live.json
  |  and appends graph price_move facts to data/price_moves.json
  v
The Desk page, via the Netlify function /api/desk-data,
which reads the bus GET /snapshot when BUS_URL and BUS_TOKEN are set
and falls back to Yahoo otherwise.
```

The Finnhub dashboard webhook is the second feed path. The Netlify
function `../desk/netlify/functions/finnhub-webhook.js` verifies the
webhook secret, acks 200, then POSTs the verified event to the bus
`/ingest` when `BUS_URL` and `BUS_TOKEN` are set on Netlify.

## Railway service settings (dashboard step)

- Root directory: `desk-services`
- Builder: Dockerfile (auto-detected; no build command)
- Start command: none (the Dockerfile CMD runs `./start.sh`)
- `PORT` is provided by Railway. The bus binds `0.0.0.0` on it.

## Environment variables (set on Railway, never committed)

| Variable | Value |
| --- | --- |
| `BUS_TOKEN` | Generate a long random token at service creation. The same value goes on Netlify as `BUS_TOKEN` so `/api/desk-data` and the webhook receiver can call the bus. **Never run this service on a public URL without `BUS_TOKEN` set.** Without it, `/ingest` stays disabled and no ticks land on the bus. |
| `FINNHUB_API_KEY` | The Finnhub API key. Set when the key is fixed; it still returns 401 as of Nov 6, 2026. The service runs without it: the bus and consumer keep working, the websocket retries with backoff. |
| `HOST` | Optional. Default `0.0.0.0` in `start.sh`. |
| `PORT` | Provided by Railway. |

Netlify also needs, on the `opone-desk` site: `BUS_URL` (the Railway
service public URL, e.g. `https://<service>.up.railway.app`) and the
same `BUS_TOKEN`. No other Netlify change is needed: `/api/desk-data`
tries the bus first and falls back to Yahoo.

## Files

```text
desk-services/
  Dockerfile              eclipse-temurin:17-jdk, builds bus + normalizer
  start.sh                starts bus, websocket chain, consumer loop
  .gitignore              runtime files (log, live JSON, facts, *.log)
  README.md               this file
  events.sample.jsonl     three valid example events
  data/
    desk-data.json        consumer baseline (Nov 6, 2026 snapshot)
  java/
    EventBus.java         the event bus (JDK stdlib only)
    README.md             build, run, endpoints, limits
  cpp/
    TickNormalizer.cpp    the tick normalizer (stdlib only)
    README.md             build, run, test, limits
  python/
    finnhub_ws.py         Finnhub websocket transport (Railway copy)
    feeder.py             stdin ticks -> POST /ingest
    consumer.py           bus log -> desk-data + graph facts
```

No `.class` files and no compiled `tick-normalizer` binary are
committed. The Dockerfile compiles both at build time.

## The event contract

Every event is one JSON object (spec section 7). Required fields: `type`,
`id`, `ts`, `source`, `feed`, `payload`. `graph_refs` is optional and
defaults to `[]`. `type` must be one of: `quote.tick`, `quote.level`,
`news.event`, `trade.signal`, `trade.placed`, `trade.filled`,
`trade.trimmed`, `trade.stopped`, `alert.trigger`, `brief.published`,
`graph.pattern`, `graph.connector`.

## Rules these services follow

- No secrets anywhere in code or logs. The Finnhub key and the bus
  token arrive as env vars only. The Java bus and the C++ normalizer
  never see a credential; the bus token is only compared, never logged.
- The bus binds `0.0.0.0` on Railway because Railway routes to the
  container port. `/ingest` and `/snapshot` require the Bearer token
  whenever `BUS_TOKEN` is set. Do not expose the service without it.
- No em dashes in any user-facing text in this folder.
- The log is the record. The bus never edits an event, never
  deduplicates, never deletes. A bad line is rejected and reported,
  never silently fixed.
- The websocket is the only part that touches Finnhub. While the key
  is 401 it exits fast and `start.sh` retries with backoff. The bus
  and consumer keep running either way.

## What is NOT built here

- The Desk web surface itself (`readable-suite/desk/`). These services
  are the plumbing it reads from.
- The poller bridge (Robinhood MCP quotes, the 5 minute watch, Discord
  reads as bus events). That is the next service to build.
- Durable event storage. `data/events.jsonl` lives on the container
  filesystem and is lost on redeploy. The log is the live record, not
  the archive; the graph facts the consumer writes are the durable
  part, and they belong in the repo over time.
