#!/bin/bash
# OpOne Capital Desk feed pipeline (Railway service).
#
# Starts three things and keeps them alive:
#   1. Java event bus (the record; serves SSE, /snapshot, /ingest).
#   2. Finnhub websocket -> C++ tick normalizer -> feeder -> bus /ingest.
#      Retries forever with backoff. While the Finnhub key is 401 the
#      websocket exits fast and the loop waits 30s between tries. The bus
#      and the consumer are never affected.
#   3. Python consumer loop: every 30s it folds the latest ticks from the
#      bus log into the live desk-data and graph facts.
#
# The bus is the long-lived process. If it dies, this script exits and
# Railway restarts the service.
#
# Env:
#   PORT            Railway provides it. Default 8899 for local runs.
#   HOST            Bind host. Default 0.0.0.0 on Railway, 127.0.0.1 local.
#   BUS_TOKEN       Bearer token for /ingest and /snapshot. Generate a long
#                   random token at service creation. When unset, /ingest
#                   stays disabled and no ticks land on the bus.
#   FINNHUB_API_KEY Finnhub key for the websocket. Set when the key is
#                   fixed; currently 401. The service runs without it.
#   DATA_DIR        Where the log and runtime files live. Default data/.
set -u
cd "$(dirname "$0")"

PORT="${PORT:-8899}"
HOST="${HOST:-0.0.0.0}"
DATA_DIR="${DATA_DIR:-data}"
LOG_FILE="$DATA_DIR/events.jsonl"
mkdir -p "$DATA_DIR"

# The Docker image has java on PATH (eclipse-temurin). A local run needs a
# JDK on PATH instead. Fail fast with a clear error rather than a silent
# restart loop when the runtime is missing.
if ! command -v java >/dev/null 2>&1; then
  echo "ERROR: java not found on PATH. Install a JDK 11+ or set PATH to one." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found on PATH." >&2
  exit 1
fi
if [ ! -x ./tick-normalizer ]; then
  echo "ERROR: ./tick-normalizer not found. Build it first: g++ -std=c++17 -O2 -Wall -Wextra -o tick-normalizer cpp/TickNormalizer.cpp" >&2
  exit 1
fi

if [ -z "${BUS_TOKEN:-}" ]; then
  echo "WARNING: BUS_TOKEN is not set. /ingest stays disabled and no ticks will land on the bus. Set BUS_TOKEN on Railway." >&2
fi
if [ -z "${FINNHUB_API_KEY:-}" ]; then
  echo "WARNING: FINNHUB_API_KEY is not set. The websocket will fail until the key is fixed. The bus and consumer keep running." >&2
fi

# 1. Java event bus. Stdin is /dev/null on purpose: events arrive over
# POST /ingest from the feeder and the Netlify webhook, not stdin.
# The bus keeps serving the log after stdin closes.
java -cp java EventBus --port "$PORT" --log "$LOG_FILE" < /dev/null &
BUS_PID=$!

# 2. Python consumer loop.
consumer_loop() {
  while true; do
    python3 python/consumer.py --log "$LOG_FILE" \
      --baseline data/desk-data.json \
      --out "$DATA_DIR/desk-data-live.json" \
      --facts "$DATA_DIR/price_moves.json" >>"$DATA_DIR/consumer.log" 2>&1 || true
    sleep 30
  done
}
consumer_loop &
CONSUMER_PID=$!

# 3. Finnhub websocket chain, retrying forever. Fast failure (bad key,
# no network) waits 30s; a healthy run that ends waits 5s.
ws_loop() {
  while true; do
    start_ts=$(date +%s)
    python3 python/finnhub_ws.py MU QCOM GLD AMD DUOL DIA SPY --seconds 3600 2>>"$DATA_DIR/ws.log" \
      | ./tick-normalizer 2>>"$DATA_DIR/normalizer.log" \
      | python3 python/feeder.py 2>>"$DATA_DIR/feeder.log"
    elapsed=$(($(date +%s) - start_ts))
    if [ "$elapsed" -lt 10 ]; then delay=30; else delay=5; fi
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ws chain ended after ${elapsed}s; retry in ${delay}s" >>"$DATA_DIR/ws.log"
    sleep "$delay"
  done
}
ws_loop &
WS_PID=$!

trap 'kill $BUS_PID $CONSUMER_PID $WS_PID 2>/dev/null' EXIT
wait $BUS_PID
