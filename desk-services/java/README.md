# Java event bus

The Desk event bus. Dependency free, JDK standard library only. No Maven,
no Gradle, no downloads.

## What it is

`EventBus.java` is the single program that owns the Desk event log. It reads
JSON event lines from stdin, validates each one against the contract in spec
section 7, appends valid events to an events JSONL log file, and serves the
log over HTTP SSE on localhost for the Desk.

## Contract

Every event is one JSON object. Required fields: `type`, `id`, `ts`,
`source`, `feed`, `payload`. `graph_refs` is optional and is added as `[]`
when absent. `type` must be one of the twelve types in the spec:
`quote.tick`, `quote.level`, `news.event`, `trade.signal`, `trade.placed`,
`trade.filled`, `trade.trimmed`, `trade.stopped`, `alert.trigger`,
`brief.published`, `graph.pattern`, `graph.connector`.

A line that fails validation is rejected, counted, and reported to stderr.
It is never written to the log and never broadcast.

## Build

JDK 11 or later is required. The sandbox has Temurin 17 at
`~/workspace/.jdk/jdk-17.0.21+9`; the Railway image uses
`eclipse-temurin:17-jdk` and compiles here at build time.

```sh
cd desk-services/java
javac EventBus.java
```

## Run

```sh
java EventBus --port 8899 --log ../events.jsonl
```

Defaults: port `8899`, log `events.jsonl` in the working directory.
Host and port also come from the environment: `HOST` (default
`127.0.0.1`), `PORT` (default `8899`, Railway provides it),
`BUS_TOKEN` (when set, `/ingest` and `/snapshot` require
`Authorization: Bearer <token>`; when unset, `/ingest` stays disabled
and `/snapshot` is open). The server binds to `HOST`. If the JDK
refuses the built in HTTP server module, run with
`java --add-modules jdk.httpserver EventBus ...`.

Feed it events, for example:

```sh
cat ../events.sample.jsonl | java EventBus --port 8899 --log ../events.jsonl
```

The program keeps serving after stdin closes, so the Desk can keep
reading the log.

## Endpoints

- `GET /events` : SSE stream, `text/event-stream`. Replays the whole log
  first, then streams live events as `data: {...}` lines, with a `: ping`
  heartbeat every 15 seconds. `GET /events?after=<id>` replays only the
  events after the event with that id.
- `GET /health` : `{"status":"ok","accepted":N,"rejected":M}`.
- `GET /snapshot` : latest `quote.tick` per symbol as JSON:
  `{"status":"ok","accepted":N,"rejected":M,"ticks":{"MU":{"price":690.00,...}}}`.
  Requires the Bearer token whenever `BUS_TOKEN` is set.
- `POST /ingest` : accept one bus event as JSON, same validation as
  stdin. Requires `Authorization: Bearer <token>` when `BUS_TOKEN` is
  set; returns 404 when it is unset, 401 on a wrong or missing token,
  400 on a rejected event, 200 `{"status":"accepted"}` on success.
- `GET /` : short help text.

Test the stream while the bus runs:

```sh
curl -N http://127.0.0.1:8899/events
curl http://127.0.0.1:8899/health
curl http://127.0.0.1:8899/snapshot
curl -X POST http://127.0.0.1:8899/ingest \
  -H "Authorization: Bearer $BUS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"quote.tick","id":"x","ts":"2026-11-07T09:00:00.000Z","source":"finnhub","feed":"finnhub","payload":{"symbol":"MU","price":690.00}}'
```

## Limits, stated plainly

- No auth on `/events`, `/health`, or `/` by design; they are read paths.
  `/ingest` and `/snapshot` require the token whenever `BUS_TOKEN` is
  set. Do not expose this port without `BUS_TOKEN` set. The Desk reads
  it from the same machine, or through the token.
- Replay is the full log (or everything after `?after=`). There is no
  paging. The log is the record; rotate it by hand when it grows.
- A restart re-reads the log and counts its lines, so `/health` stays
  honest across restarts. Events are never deduplicated: a producer that
  replays its own output will double log. Producers must send each event
  once.
- No secrets are read, logged, or emitted anywhere in this program.
