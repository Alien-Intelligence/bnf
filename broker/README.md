# BnF Broker

The single egress chokepoint for all BnF traffic (app metadata resolver + ingest worker). It exists because the BnF partner API enforces a **shared 300/min global** quota across all APIs per credential, plus a **40/min-per-IP** cap on IIIF manifests — limits that two independent processes cannot honour without one coordination point.

## What it owns

- **OAuth token** — single-flight client_credentials mint, ~1h bearer, re-minted at expiry − skew. The BnF `KEY`/`SECRET` live ONLY here.
- **Rate governance** — configurable token buckets: `global` (300/min), `manifest` (40/min/IP), `external` (politeness for the ungated `oai`/`catalogue`/`data` hosts, not counted against the partner quota).
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

## Saturating the cap (worker side)

The broker is the sole **rate** authority. The worker keeps the broker's bucket continuously fed via a process-global **fetch semaphore** (`BNF_FETCH_CONCURRENCY`, in `worker/src/prepare/fetch-gate.ts`) — a *concurrency* gate only, no rate logic, so there is no double-throttle. It sits below the per-document loop, so a document in chunk/embed/index holds no permits and other documents' page fetches fill them. Throughput therefore stays pinned at the broker cap instead of collapsing whenever a doc leaves the fetch phase.

Sizing rule: `permits ≈ cap × target-acquire-wait-seconds / 60`. Pick the **smallest** value that holds the sustained cap with `freeze≈0`/`shed≈0`.

**Measured at the 300/min cap (`BNF_FETCH_CONCURRENCY=12`, 2026-06-25):** peak in-flight held exactly 12; sustained **300/min** whenever fetch work was pending; **`freeze=0`, `shed=0`, `retry_after` never set** across 2546 global calls; acquire-wait p50 **2.3s** (well under the 15s ALTO page timeout). 12 is the locked default.

## Raising the quota — the 3000/min runbook

BnF has signalled the global quota will rise (hoped-for **3000/min**). When it does, it is **two env values and a `helm upgrade` — no code change, no app rebuild**:

1. **Broker** — `broker.config.globalRpm: "3000"` in `helm/bnf-demo-chart/values.yaml` (or `BNF_GLOBAL_RPM=3000` in the env). This is the only place the rate ceiling lives.
2. **Worker** — `worker.config.bnfFetchConcurrency: "48"` (`≈ 3000 × 1s / 60`, the sizing rule above for a ~1s wait). Leave `workerConcurrency` as the memory bound; it is not a throughput knob.
3. `helm upgrade --install bnf-demo-prod helm/bnf-demo-chart --kube-context platform-prod -n bnf` (broker + worker pods recreate; clients absorb the broker's seconds of `Recreate` downtime as transient retries).
4. **Verify** via the call log: `GET /calls.csv` (or `kubectl exec deploy/bnf-demo-prod-broker -- wget -qO- localhost:8792/calls.csv`). Confirm per-minute `global` `ok` ≈ 3000 sustained, `freeze≈0`, `shed≈0`. If `shed`/`freeze` climb, the cap or the upstream is the limit — lower `bnfFetchConcurrency`, don't raise it. If acquire-wait approaches the 15s page timeout, the gate is too wide for the rate.

Bumping `BNF_MANIFEST_RPM` follows the same path (broker-only; manifests are a small fraction of traffic and rarely the bottleneck).
