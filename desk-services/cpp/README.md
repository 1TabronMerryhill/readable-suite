# C++ tick normalizer

The Finnhub trade translator. Standard library only. No external JSON
library. The JSON parsing is a minimal recursive descent parser written
for the known Finnhub trade shape.

## What it is

`TickNormalizer.cpp` reads Finnhub trade JSON lines from stdin and emits
Desk `quote.tick` JSON lines to stdout, one per trade, in the event
contract shape from spec section 7.

Input (raw Finnhub websocket trade message):

```json
{"type":"trade","data":[{"s":"MU","p":691.73,"v":10,"t":1793990400000}]}
```

`s` is the symbol, `p` the price, `v` the volume, `t` the epoch millis
time. `v` and `t` are optional. When `t` is missing, receipt time is
used. When `t` looks like seconds instead of millis, it is scaled up.

Output (one line per trade):

```json
{"type":"quote.tick","id":"finnhub-MU-1793990400000-0","ts":"2026-11-06T18:40:00.000Z","source":"finnhub","feed":"finnhub","payload":{"symbol":"MU","price":691.73,"volume":10},"graph_refs":[]}
```

The id is deterministic: `finnhub-<symbol>-<epoch millis>-<index in message>`.
The timestamp is ISO-8601 UTC with millis. Prices keep their raw literal,
so no rounding is introduced by the normalizer.

## Lines it passes through

A line that already carries type `quote.tick` and the required contract
fields (`id`, `ts`, `source`, `feed`, `payload`) is passed through
unchanged. This makes the pipeline safe when the producer already emits
contract events, as `finnhub_ws.py` does.

Anything else is skipped with a note on stderr: pings, status lines,
malformed JSON, trades without a symbol or price. Skipped lines never
crash the program. A one line summary goes to stderr at end of input.

## Build

```sh
cd desk-services/cpp
g++ -std=c++17 -O2 -Wall -Wextra -o tick-normalizer TickNormalizer.cpp
```

Verified Nov 6, 2026 in this sandbox with g++ 13.3.0: compiles with no
warnings.

## Run

```sh
./tick-normalizer < trades.jsonl > ticks.jsonl
```

Full pipeline (see `../README.md`):

```sh
python3 ~/workspace/custom-connectors/custom.finnhub/bin/finnhub_ws.py MU QCOM GLD \
  | ./tick-normalizer \
  | java EventBus --port 8899 --log ../events.jsonl
```

## Test

Feed it the sample input and check the output is valid JSON with the
required contract fields:

```sh
printf '%s\n' \
  '{"type":"trade","data":[{"s":"MU","p":691.73,"v":10,"t":1793990400000},{"s":"QCOM","p":166.23,"v":5,"t":1793990400500}]}' \
  '{"type":"trade","data":[{"s":"GLD","p":372.79,"t":1793990401000}]}' \
  '{"type":"ping"}' \
  'not json at all' \
  | ./tick-normalizer
```

Expected: three `quote.tick` lines on stdout (MU, QCOM, GLD), skip notes
on stderr, and a summary line `normalized 3 ticks from 3 trade messages,
passed through 0, skipped 2`.

## Limits, stated plainly

- It parses JSON, not the websocket. The websocket connection itself is
  `finnhub_ws.py`. This program only translates what that program prints.
- Numbers are kept as raw literals. A price of `691.730` stays `691.730`.
  The Desk, not this program, decides how to display it.
- No secrets are read, logged, or emitted anywhere in this program.
  No network calls. Stdin in, stdout out.
