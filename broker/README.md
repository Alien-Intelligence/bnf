# BnF Broker

The single egress chokepoint for the BnF traffic of the bnf demo (app metadata resolver + ingest worker). It exists because the BnF partner API meters one credential with per-minute quotas that two independent processes cannot honour without one coordination point. It holds the **ingestion** subscription's key; the agent's MCP path (mcp-bnf, through the platform External-API connectors) is a separate egress on the separate **interface** key and never goes through here.

## What it owns

- **OAuth token** — single-flight client_credentials mint, ~1h bearer, re-minted at expiry − skew. The BnF `KEY`/`SECRET` live ONLY here.
- **Rate governance** — one token bucket per quota of the ingestion subscription (`src/plan.ts`):
  - `global` — the subscription's cap over every partner API together;
  - one bucket per partner API, classified by path prefix on the partner host (the version segment is excluded, so `…/1.0.1/…` classifies the same):

    | Bucket | Path prefix | BnF API |
    |---|---|---|
    | `presentation` | `/presentation/iiif/gallica/` | PRESENTATION_IIIF_GALLICA (manifest, ALTO, toc, …) |
    | `image` | `/image/iiif/gallica/` | IMAGE_IIIF_GALLICA |
    | `iiifLegacy` | `/iiif/` | Gallica-IIIF (the legacy combined API) |
    | `catalogue` | `/catalogueservice-cons/` | CATALOGUESERVICE-CONS (catalogue SRU) |
    | `gallicaSru` | `/recherche/sru/gallica/` | SRU_GALLICA |
    | `grapheData` | `/graphe/data/` | GRAPHE_DATA (data.bnf SPARQL) |
    | `datePeriodique` | `/date/periodique/gallica/` | DATE_PERIODIQUE |
    | `documentTdm` | `/document/tdm/gallica/` | DOCUMENT_TDM |

  - `manifest` — the per-IP sub-limit on IIIF manifests (`…/presentation/vN/…/manifest.json`, on the new and the legacy API alike);
  - `external` — politeness for the ungated `oai`/`catalogue`/`data` hosts; not a BnF quota.
- **Acquire** — a request takes `[manifest?] + api + global`, most specific first, under ONE wait budget (`BNF_ACQUIRE_MAX_WAIT_MS`, measured from its arrival). If any bucket cannot grant within it, the request is shed with a 429 and the tokens it already took are refunded (nothing was sent for them).
- **Unknown partner paths are refused** — a partner-host path outside the eight prefixes gets 403 `unclassified partner-API path: <path>`, logged with note `unclassified`. It is never charged to a guessed bucket, and never sent on `global` alone (it could breach a quota we do not model). A new BnF API is a new row in `PARTNER_API_PREFIXES` plus its rates.
- **429 backoff** — parses `Retry-After` (else the next clock-minute boundary), freezes the request's most specific bucket (`manifest`, else the API bucket) — **never `global`**: BnF does not say which quota tripped, and a global freeze on one API's 429 would stall all of them — and mirrors the 429 to the caller.

## Contract

```
POST /fetch     {"url": "https://openapiproext.bnf.fr/presentation/iiif/gallica/1.0.0/...", "accept": "application/xml"}
                -> upstream status + body, verbatim (content-type preserved)
                   403 for a non-*.bnf.fr host or an unclassified partner path; 429 when shed
GET  /health    -> {"ok": true}
GET  /calls.csv -> one row per /fetch outcome; ?reset=1 clears the buffer after returning it
```

Only `*.bnf.fr` upstreams are accepted (SSRF guard). Partner-API hosts get a Bearer token; ungated hosts use the politeness bucket and no auth.

`calls.csv` columns: `timestamp_iso,epoch_ms,host,path,status,bucket,authed,wait_ms,fetch_ms,retry_after,note,acquired,shed_by`. `bucket` is the most specific bucket of the request (`manifest`, else the API bucket, else `external`; empty for `unclassified`). `acquired` is the plan joined with `+` (`manifest+presentation+global`). `shed_by` names the bucket that shed a `shed` row. `note` is one of `ok`, `shed`, `freeze` (a real BnF 429), `freeze_403`, `remint`, `upstream_error`, `truncated_upstream`, `unclassified`. The last two columns were appended, so every earlier column keeps its index.

## Configuration

Every bucket's rate is **required**, carried by ONE variable, `BNF_RATES`: a JSON object `{"<bucket>": {"rpm": n, "burst": n}, …}` with exactly the buckets `global`, `manifest`, `external`, `presentation`, `image`, `iiifLegacy`, `catalogue`, `gallicaSru`, `grapheData`, `datePeriodique`, `documentTdm` (see `.env.example`). A missing, unknown or non-integer bucket or field stops the broker at boot, naming every problem: a rate is a BnF quota decision, never a code default, and a new image booted with an old ConfigMap fails loudly instead of running on guesses. The chart renders it from `broker.config.rates`, and the worker reads its four gates from the same object. `BNF_CLIENT_KEY` / `BNF_CLIENT_SECRET` are required too. Timeouts and sizes keep documented defaults (`src/config.ts`).

In the chart the rates live in ONE place, `broker.config.rates.<bucket>.{quota,rpm,burst}` in `helm/bnf-demo-chart/values.yaml`; the worker's own gates render from the same keys.

**The margin rule.** BnF counts fixed clock-minute windows, and a token bucket can emit `rpm + burst` inside one, so the invariant is `rpm + burst ≤ quota`; the chart fails the render when it does not hold. The values follow `rpm = floor(0.95 × quota)`, `burst = max(1, floor(0.02 × quota))`, which absorbs the traffic the buckets share between the worker and the app resolver.

## Security posture

`POST /fetch` and `GET /calls.csv` have **no authentication of their own** — the broker trusts the cluster network (any pod that can reach `:8792` can fetch through it or read the call log). This is accepted for the demo deployment: the broker is not exposed outside the cluster, and the real secret it protects (the BnF `KEY`/`SECRET`) never leaves it. Flagged for ISO 27001 work (F22, `ai-memories/tech/repos/bnf/ingest-hardening`) — a production posture would put a shared bearer token or mTLS between the worker/app and the broker instead of relying on network placement alone.

## Run

```bash
cp .env.example .env   # fill BNF_CLIENT_KEY / BNF_CLIENT_SECRET; the rates are pre-filled
npm install
npm start              # tsx src/server.ts  ->  :8792; the startup line lists every bucket's rpm/burst
```

Clients (app `lib/bnf/broker-client.ts`, worker `worker-v2/src/bnf/broker-client.ts`) point at it via `BNF_BROKER_URL`.

## Feeding the buckets (worker side)

The broker is the rate **authority**; worker-v2 mirrors its rates with in-process gates so it does not offer far more than the broker grants (every shed is a wasted round trip). Its ALTO fetch stage is gated by `presentation ∧ global`, its image fetch stage by `image ∧ global`, its manifest fetches by `manifest ∧ presentation ∧ global` — the same values, rendered from the same chart keys. Each fetch stage's concurrency is sized `permits ≈ rpm × latency_s / 60` with headroom (`BNF_ALTO_FETCH_CONCURRENCY`, `BNF_IMAGE_FETCH_CONCURRENCY`); see `worker-v2/RUN.md`.

## Raising a quota

When BnF raises a quota, it is a values change and a `helm upgrade` — no code change:

1. Edit `broker.config.rates.<bucket>` in `helm/bnf-demo-chart/values.yaml`: set `quota` to the new allowance and `rpm`/`burst` by the margin rule above. The render fails if `rpm + burst > quota`.
2. If the throughput target moves a lot, re-size the worker fetch concurrency (`worker.config.altoFetchConcurrency` / `imageFetchConcurrency`) by the sizing rule.
3. `helm upgrade --install bnf-demo-prod helm/bnf-demo-chart --kube-context platform-prod -n bnf` (broker + worker pods recreate; clients absorb the broker's seconds of `Recreate` downtime as transient retries).
4. **Verify** via the call log (`kubectl exec deploy/bnf-demo-prod-broker -- wget -qO- localhost:8792/calls.csv`): per minute, `ok` on the raised bucket ≈ its rpm while work is pending, `freeze` ≈ 0, and `shed` explained by `shed_by`. Real 429s (`freeze`) mean the new value is above what BnF enforces — lower it.
