# BnF Broker

The single egress chokepoint for all BnF traffic (app metadata resolver + ingest worker). It exists because the BnF partner API enforces a **shared 300/min global** quota across all APIs per credential, plus a **12/min-per-IP** cap on IIIF manifests — limits that two independent processes cannot honour without one coordination point.

## What it owns

- **OAuth token** — single-flight client_credentials mint, ~1h bearer, re-minted at expiry − skew. The BnF `KEY`/`SECRET` live ONLY here.
- **Rate governance** — configurable token buckets: `global` (300/min), `manifest` (12/min/IP), `external` (politeness for the ungated `oai`/`catalogue`/`data` hosts, not counted against the partner quota).
- **429 backoff** — parses the absolute-GMT `Retry-After`, freezes the offending bucket until then, and mirrors the 429 to the caller.

## Contract

```
POST /fetch   {"url": "https://openapi.bnf.fr/iiif/...", "accept": "application/xml"}
              -> upstream status + body, verbatim (content-type preserved)
GET  /health  -> {"ok": true}
```

Only `*.bnf.fr` upstreams are accepted (SSRF guard). Partner-API hosts get a Bearer token + the global cap; manifests additionally take the manifest cap; ungated hosts use the politeness bucket and no auth.

## Run

```bash
cp .env.example .env   # fill BNF_CLIENT_KEY / BNF_CLIENT_SECRET
npm install
npm start              # tsx src/server.ts  ->  :8792
```

Clients (app `lib/bnf/broker-client.ts`, worker `worker/src/prepare/broker-client.ts`) point at it via `BNF_BROKER_URL`. When `BNF_BROKER_URL` is unset, callers fall back to their direct path (dev without the broker).

## Caps will rise

BnF has signalled the quota will increase. Bump `BNF_GLOBAL_RPM` / `BNF_MANIFEST_RPM` in the environment — no code change, no redeploy of the app/worker.
