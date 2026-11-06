#!/usr/bin/env python3
"""Desk feed feeder.

Reads Desk quote.tick JSON lines from stdin (the C++ tick normalizer
output) and POSTs each one to the Java event bus POST /ingest with the
BUS_TOKEN Bearer token.

Why a feeder instead of piping straight into the bus stdin: the bus
reads stdin once, and when that pipe closes it never reopens. A websocket
that drops and reconnects needs a path that survives reconnects, and
/ingest is that path. The feeder is that path.

Stdlib only. No secrets are logged. A failed POST is reported to stderr
and the line is dropped; the feeder never crashes and never blocks the
pipe. When BUS_TOKEN is unset, /ingest is disabled, so the feeder warns
once and drains stdin without posting. Exits 0 on stdin EOF so the
start.sh loop can restart the websocket chain.

Env:
  PORT       bus port, default 8899 (Railway provides PORT)
  BUS_TOKEN  Bearer token for /ingest
"""

import json
import os
import sys
import urllib.error
import urllib.request

PORT = os.environ.get("PORT", "8899")
TOKEN = os.environ.get("BUS_TOKEN", "")
URL = "http://127.0.0.1:%s/ingest" % PORT


def post(line):
    req = urllib.request.Request(
        URL,
        data=line.encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + TOKEN,
        },
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        resp.read()


def main():
    if not TOKEN:
        print("feeder: BUS_TOKEN not set, /ingest is disabled; "
              "ticks will be dropped", file=sys.stderr)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if not TOKEN:
            continue
        try:
            # Skip anything that is not a JSON object; the bus would
            # reject it anyway, and the log stays clean.
            json.loads(line)
        except json.JSONDecodeError:
            print("feeder: skip non-JSON line", file=sys.stderr)
            continue
        try:
            post(line)
        except Exception as e:
            print("feeder: ingest failed: %s" % e, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
