#!/usr/bin/env python3
"""Desk feed consumer (proof).

Reads validated quote.tick events from the Java event bus JSONL log and
turns them into two things, in the firm's existing shapes:

1. A desk-data.json update, same shape as
   ~/workspace/bobby-axelrod/desk-build/desk-data.json. Only the live
   fields move: last prices, pnl, book totals, attention, generated,
   quotes_as_of. The brief, the Wire, and the graph map stay on the
   daily snapshot, exactly as the live Desk page does.
2. A graph price_move fact, same shape as
   ~/workspace/bobby-axelrod/knowledge-graph/facts/price_moves.json
   (asset, date, direction, feed, id, magnitude_pct, note, trade_id,
   window). Ticks are window "tick" and are never presented as trades.

Stdlib only. No network. No secrets. Reads the log file, which is the
same record the bus serves over SSE, so this consumer and an SSE
subscriber can never disagree.

Usage:
  python3 consumer.py --log ../proof/events.jsonl \
    --baseline ../../desk-build/desk-data.json \
    --out ../proof/desk-data-live.json \
    --facts ../proof/price_moves.json
"""

import argparse
import datetime
import json
import os
import sys

# Symbol to graph trade id, from the Nov 6 real executions. Only these
# three symbols have a live position and a trade id. Anything else gets
# a fact with no trade_id.
TRADE_IDS = {
    "MU": "trade:2026-11-06-8",
    "QCOM": "trade:2026-11-06-9",
    "GLD": "trade:2026-11-06-10",
}


def load_jsonl(path):
    events = []
    if not os.path.exists(path):
        return events
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            events.append(json.loads(line))
    return events


def latest_ticks(events):
    ticks = {}
    for e in events:
        if e.get("type") != "quote.tick":
            continue
        p = e.get("payload") or {}
        sym = p.get("symbol")
        price = p.get("price")
        if not sym or not isinstance(price, (int, float)):
            continue
        ticks[sym] = (price, e)
    return ticks


def round2(n):
    return round(n + 1e-12, 2)


def attention_for(gld_last):
    if gld_last is None:
        return None
    if gld_last >= 375.39:
        return "Gold is within $1 of its GLD target $376.39 (spot $4,090). This needs you."
    if gld_last <= 369.16:
        return "Gold is within $1 of its GLD stop $368.16 (spot $4,000). This needs you."
    return "Nothing needs you right now."


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True, help="bus JSONL log")
    ap.add_argument("--baseline", required=True, help="desk-data.json snapshot")
    ap.add_argument("--out", required=True, help="updated desk-data.json to write")
    ap.add_argument("--facts", required=True, help="price_moves.json to append to")
    args = ap.parse_args()

    events = load_jsonl(args.log)
    ticks = latest_ticks(events)
    if not ticks:
        print("no quote.tick events in log; nothing to apply")
        return 0

    with open(args.baseline, encoding="utf-8") as f:
        data = json.load(f)

    applied = []
    facts = []
    if os.path.exists(args.facts):
        with open(args.facts, encoding="utf-8") as f:
            facts = json.load(f)
    seen_fact_ids = {x.get("id") for x in facts}

    for pos in data.get("positions", []):
        sym = pos.get("symbol")
        if sym not in ticks:
            continue
        price, evt = ticks[sym]
        fill = pos.get("fill")
        pos["last"] = price
        pos["pnl"] = round2((price - fill) * pos.get("qty", 0))
        applied.append(sym)
        # Graph fact, same shape as knowledge-graph/facts/price_moves.json.
        ts = evt.get("ts", "")
        date = ts[:10] if len(ts) >= 10 else datetime.date.today().isoformat()
        millis = evt.get("id", "").split("-")[-2] if "-" in evt.get("id", "") else "0"
        fact_id = "move:%s-%s-tick-%s" % (date, sym.lower(), millis)
        if fact_id not in seen_fact_ids:
            direction = "up" if price >= fill else "down"
            fact = {
                "asset": sym,
                "date": date,
                "direction": direction,
                "feed": evt.get("feed", "finnhub"),
                "id": fact_id,
                "magnitude_pct": round2((price - fill) / fill * 100),
                "note": "live tick from the proof pipe, not an executed trade",
                "window": "tick",
            }
            if sym in TRADE_IDS:
                fact["trade_id"] = TRADE_IDS[sym]
            facts.append(fact)
            seen_fact_ids.add(fact_id)

    for cond in data.get("conditionals", []):
        sym = cond.get("symbol")
        if sym in ticks:
            cond["last"] = ticks[sym][0]
            applied.append(sym + " (conditional)")

    # Recompute the real book from live lasts.
    equity = round2(sum(p["last"] * p["qty"] for p in data.get("positions", [])))
    cash = data["book"]["real"]["cash"]
    data["book"]["real"]["equity"] = equity
    data["book"]["real"]["total"] = round2(equity + cash)

    # Attention follows the GLD tick, same rule as the live endpoint.
    if "GLD" in ticks:
        new_attention = attention_for(ticks["GLD"][0])
        if new_attention is not None:
            data["attention"] = new_attention

    data["generated"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    data["quotes_as_of"] = (
        "live tick from the Java event bus, feed finnhub; "
        "gold spot as of 13:16 CT Nov 6, 2026 (Yahoo snapshot)"
    )

    for path, obj in ((args.out, data), (args.facts, facts)):
        parent = os.path.dirname(os.path.abspath(path))
        os.makedirs(parent, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=1)
            f.write("\n")

    print("applied ticks for: %s" % ", ".join(applied))
    print("book real total: %s (equity %s, cash %s)"
          % (data["book"]["real"]["total"], equity, cash))
    print("wrote %s" % args.out)
    print("facts: %d total in %s" % (len(facts), args.facts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
