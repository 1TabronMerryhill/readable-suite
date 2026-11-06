#!/usr/bin/env python3
"""Finnhub websocket client for OpOne Capital: the real-time webhook feed.

RAILWAY COPY. The sandbox original lives at
~/workspace/custom-connectors/custom.finnhub/bin/finnhub_ws.py. This copy
differs in two ways, both needed to run on Railway:
  1. The key comes from the FINNHUB_API_KEY env var first. Only when it is
     unset does it fall back to the vault surrogate (sandbox only).
  2. It prints RAW Finnhub trade messages, {"type":"trade","data":[...]},
     and lets the C++ tick normalizer turn them into Desk quote.tick
     events. The original printed pre-shaped flat ticks that the
     normalizer skips (no id, no payload), so piping the original into
     the normalizer drops every tick.

Connects to wss://ws.finnhub.io and subscribes to the firm's symbols.

Free tier: 1 concurrent websocket connection per key, up to 50 symbols,
real-time US trades plus forex and crypto. The dedicated news websocket is
a Premium feature; news stays on REST /company-news and /news.

Events emitted:
  {"type":"trade","data":[{"s":"MU","p":691.73,"v":10,"t":1793990400000}]}
  plus {"type":"finnhub_msg","raw":...} for non-trade messages, which the
  normalizer skips, and a {"status":"subscribed",...} line at connect.

Usage:
  finnhub_ws.py [SYMBOL ...] [--seconds N]
  Defaults: MU QCOM GLD AMD DUOL DIA SPY, 60 seconds.
  Exit code 0: clean run. 2: auth/connection failure (key or swap).

Stdlib only: no websockets library. Handshake and framing are implemented
directly (RFC 6455 text frames, ping/pong, close).
"""
import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import sys
import time
import urllib.parse

try:
    sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
    from dynamic_credentials import dynamic_credential_entry
except Exception:
    # Railway has no vault surrogate. Env key only there.
    dynamic_credential_entry = None

HOST = "ws.finnhub.io"
PORT = 443
DEFAULT_SYMBOLS = ["MU", "QCOM", "GLD", "AMD", "DUOL", "DIA", "SPY"]
DEFAULT_SECONDS = 60


def build_url():
    key = os.environ.get("FINNHUB_API_KEY", "").strip()
    if key:
        return f"wss://{HOST}?token={urllib.parse.quote(key, safe='')}"
    if dynamic_credential_entry is None:
        raise RuntimeError(
            "no FINNHUB_API_KEY env var and no vault credential available")
    entry = dynamic_credential_entry("custom.finnhub")
    surrogate = str(entry["surrogate"]).strip()
    return f"wss://{HOST}?token={urllib.parse.quote(surrogate, safe='')}"


def ws_connect(url):
    parsed = urllib.parse.urlsplit(url)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = (
        f"GET {parsed.path}?{parsed.query} HTTP/1.1\r\n"
        f"Host: {parsed.hostname}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Origin: https://finnhub.io\r\n"
        "\r\n"
    )
    proxy = os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY") or ""
    if proxy:
        # Sandbox egress forces traffic through an HTTP proxy. Tunnel with
        # CONNECT first, then TLS, then the websocket handshake. The proxy
        # URL (with its credentials) comes from the environment; never log it.
        p = urllib.parse.urlsplit(proxy)
        raw = socket.create_connection((p.hostname, p.port or 3128), timeout=15)
        auth = ""
        if p.username:
            creds = urllib.parse.unquote(p.username)
            if p.password:
                creds += ":" + urllib.parse.unquote(p.password)
            auth = "Proxy-Authorization: Basic " + base64.b64encode(
                creds.encode("ascii")).decode("ascii") + "\r\n"
        connect = (
            f"CONNECT {parsed.hostname}:{PORT} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}:{PORT}\r\n"
            f"{auth}\r\n"
        )
        raw.sendall(connect.encode("ascii"))
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = raw.recv(4096)
            if not chunk:
                raise RuntimeError("proxy closed the CONNECT tunnel")
            resp += chunk
        if b" 200 " not in resp.split(b"\r\n", 1)[0]:
            raise RuntimeError(
                f"proxy refused CONNECT: {resp.split(chr(13), 1)[0]!r}")
    else:
        raw = socket.create_connection((parsed.hostname, PORT), timeout=15)
    ctx = ssl.create_default_context()
    sock = ctx.wrap_socket(raw, server_hostname=parsed.hostname)
    sock.sendall(request.encode("ascii"))
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("handshake closed by server (auth likely failed)")
        resp += chunk
    head = resp.split(b"\r\n", 1)[0].decode("iso-8859-1", errors="replace")
    if "101" not in head:
        raise RuntimeError(f"handshake failed: {head} :: {resp[:400]!r}")
    return sock


def send_text(sock, text):
    payload = text.encode("utf-8")
    header = bytearray([0x81])
    n = len(payload)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header += struct.pack(">H", n)
    else:
        header.append(0x80 | 127)
        header += struct.pack(">Q", n)
    mask = os.urandom(4)
    header += mask
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(bytes(header) + masked)


def recv_exact(sock, n):
    data = b""
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise RuntimeError("socket closed by server")
        data += chunk
    return data


def recv_message(sock):
    while True:
        b1, b2 = recv_exact(sock, 2)
        fin = b1 & 0x80
        opcode = b1 & 0x0F
        masked = b2 & 0x80
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack(">H", recv_exact(sock, 2))[0]
        elif length == 127:
            length = struct.unpack(">Q", recv_exact(sock, 8))[0]
        mask = recv_exact(sock, 4) if masked else None
        payload = recv_exact(sock, length) if length else b""
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        if opcode == 0x9:  # ping -> pong
            sock.sendall(bytes([0x8A, 0x80]) + os.urandom(4))
            continue
        if opcode == 0x8:  # close
            raise RuntimeError("server sent close frame")
        if opcode == 0x1 and fin:
            return payload.decode("utf-8", errors="replace")
        # continuation / binary: skip


def main():
    symbols = []
    seconds = DEFAULT_SECONDS
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--seconds" and i + 1 < len(args):
            seconds = int(args[i + 1])
            i += 2
        else:
            symbols.append(args[i])
            i += 1
    if not symbols:
        symbols = DEFAULT_SYMBOLS
    try:
        url = build_url()
    except Exception as e:
        print(json.dumps({"error": f"credential: {e}"}))
        return 2
    try:
        sock = ws_connect(url)
    except Exception as e:
        print(json.dumps({"error": f"connect: {e}"}))
        return 2
    for sym in symbols:
        send_text(sock, json.dumps({"type": "subscribe", "symbol": sym}))
    print(json.dumps({"status": "subscribed", "symbols": symbols,
                      "source": "finnhub", "feed": "finnhub"}), flush=True)
    sock.settimeout(5)
    end = time.time() + seconds
    try:
        while time.time() < end:
            try:
                msg = recv_message(sock)
            except socket.timeout:
                continue
            try:
                data = json.loads(msg)
            except json.JSONDecodeError:
                continue
            if data.get("type") != "trade":
                print(json.dumps({"type": "finnhub_msg", "raw": data}), flush=True)
                continue
            # Raw trade message. The C++ tick normalizer turns each trade
            # into a Desk quote.tick event with its id and timestamp.
            print(json.dumps({"type": "trade", "data": data.get("data", [])}),
                  flush=True)
    except RuntimeError as e:
        print(json.dumps({"error": f"stream: {e}"}))
        return 2
    finally:
        try:
            sock.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
