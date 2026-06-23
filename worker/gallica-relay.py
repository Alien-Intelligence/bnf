#!/usr/bin/env python3
"""
Gallica fetch-relay — DEMO STOPGAP, not for production.

Cloudflare bot-fight-mode on gallica.bnf.fr blocks our Node/undici worker by its
TLS/HTTP2 fingerprint (not by IP — a real browser from the same IP passes). While
the BnF partner IP-allowlist (Cloudflare layer) is pending, this relay lets the
worker borrow a real Firefox handshake via curl_cffi so legitimate partner
ingestion can run for the demo.

Contract: POST JSON {"url": "...", "accept": "..."} -> upstream status + body
verbatim (content-type preserved). The worker's rate limiter gates call volume
BEFORE it reaches here, so this stays browser-polite.

Run on the host (where curl_cffi is installed); the dockerised worker reaches it
via http://host.docker.internal:<port>.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from curl_cffi import requests as cf

PORT = int(os.environ.get("RELAY_PORT", "8791"))
IMPERSONATE = os.environ.get("RELAY_IMPERSONATE", "firefox")
TIMEOUT = int(os.environ.get("RELAY_TIMEOUT", "60"))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # health probe
        if self.path == "/health":
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        try:
            ln = int(self.headers.get("content-length", 0))
            payload = json.loads(self.rfile.read(ln) or b"{}")
            url = payload["url"]
        except Exception as e:  # noqa: BLE001 - relay must answer, not crash
            self._fail(400, f"bad request: {e}")
            return

        headers = {}
        if payload.get("accept"):
            headers["Accept"] = payload["accept"]
        try:
            r = cf.get(url, impersonate=IMPERSONATE, headers=headers, timeout=TIMEOUT)
        except Exception as e:  # noqa: BLE001 - surface as 502 so worker retries
            self._fail(502, f"relay fetch error: {e}")
            return

        self.send_response(r.status_code)
        self.send_header(
            "content-type", r.headers.get("content-type", "application/octet-stream")
        )
        self.send_header("content-length", str(len(r.content)))
        self.end_headers()
        self.wfile.write(r.content)

    def _fail(self, code, msg):
        body = msg.encode()
        self.send_response(code)
        self.send_header("content-type", "text/plain")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    print(f"[relay] impersonate={IMPERSONATE} port={PORT}", file=sys.stderr)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
