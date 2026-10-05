# Worker V2 — running it + the integration gates

Worker V2 is a **staged dataflow pipeline of durable pg-boss buckets** (design:
`../../ai-memories/tech/repos/bnf/worker-v2-pipeline/plan/v2-architecture-design.md`).
This doc covers running it locally and the three acceptance gates from the goal.

## What's tested without any infra

```bash
npm test          # 100+ unit tests + a full fake-mode integration run
# The Postgres contract suite of the OCR backfill store (skipped by `npm test`
# without a database). Point it at a Postgres YOU own — it applies schema.sql
# (idempotent) and only touches rows under a unique test ARK prefix:
WORKER_TEST_DATABASE_URL=postgresql://… npm run test:pg   # fails, never skips, without the URL
npm run typecheck # tsc --noEmit, 0 errors
```

`src/integration.test.ts` drives the **real wiring** (`buildPipeline`) end to end
with in-memory fakes: one doc per lane (text / vision / mistral) flows to
registration, plus injected 500/502 / permanent faults prove retry, the per-doc
fail-ratio, terminal failure, and the observability reconciliation invariant
(`done + failed + skipped = total`). No network, no BnF quota.

## Running against real infra (local)

Env (required vars throw at startup — see `src/config.ts` + the live clients):

```bash
DATABASE_URL=postgresql://…              # pg-boss buckets + sandbox_ingest_v2 doc state
SCW_S3_BUCKET= SCW_S3_ENDPOINT_URL= SCW_S3_REGION= SCW_S3_ACCESS_KEY= SCW_S3_SECRET_KEY=
V2_S3_PREFIX=v2/                         # isolates V2 artifacts from V1 in the shared bucket
BNF_BROKER_URL=…                         # REQUIRED at boot: the egress chokepoint (owns OAuth + the rate caps)
BNF_IIIF_PRESENTATION_BASE_URL=https://openapiproext.bnf.fr/presentation/iiif/gallica/1.0.0  # REQUIRED at boot: manifests + ALTO
BNF_IIIF_IMAGE_BASE_URL=https://openapiproext.bnf.fr/image/iiif/gallica/1.0.0                # REQUIRED at boot: folio images
# BNF_API_BASE_URL is RETIRED: set, the worker refuses to boot and names the two bases above.
# The worker's own BnF gates — REQUIRED, no defaults, the SAME values as the
# broker's buckets (helm broker.config.rates.<bucket>.rpm; broker/README.md):
BNF_GLOBAL_RPM=950                       # the ingestion subscription's global cap
BNF_PRESENTATION_RPM=1425                # Presentation API (manifests, ALTO)
BNF_IMAGE_RPM=285                        # Image API (folio images)
BNF_MANIFEST_RPM=38                      # per-IP manifest sub-limit
# Fetch concurrency per stage — REQUIRED; permits ≈ rpm × latency_s / 60 + headroom:
BNF_ALTO_FETCH_CONCURRENCY=96            # 1425 × ~3 s / 60 ≈ 71
BNF_IMAGE_FETCH_CONCURRENCY=32           # 285 × ~4 s / 60 ≈ 19
# RETIRED (set → the worker refuses to boot, naming the replacement):
#   BNF_FETCH_CONCURRENCY, MISTRAL_IMAGE_SIZE, VISION_IMAGE_SIZE, BNF_API_BASE_URL
MISTRAL_OCR_ENABLED=true                 # + MISTRAL_API_KEY … (mistral lane)
# vision: SCW_API_KEY/SCW_GENAI_BASE_URL/HOLO_MODEL + GOOGLE_AI_API_KEY  (see src/live/*)
# embed:  RunPod creds;  cluster: CLUSTER_* (mirrors V1 env.ts names)
# OCR-quality backfill (validated at startup — a malformed value throws).
# LOCAL: keep it off — each backfilled text doc spends shared BnF quota.
OCR_BACKFILL_ENABLED=false               # code default true (prod); false: no stage, sync queues nothing
OCR_BACKFILL_CONCURRENCY=2               # in-flight backfill docs (positive integer; plan D6 default)
OCR_BACKFILL_RETRY_FAILED_AFTER_MS=86400000  # base retry backoff in ms (≥ 60000), doubles per attempt (5 max)
```

Every numeric knob above is a strict integer (≥ 1; a port ≤ 65535): a zero, a
negative, a fraction or a typo throws at startup instead of being floored.

The gates compose like the broker's buckets: ALTO fetches take presentation ∧
global, image fetches image ∧ global, manifests manifest ∧ presentation ∧
global. ALTO and images run as two stages on two queues (`v2.fetch`,
`v2.fetch.image`) with their own concurrency, so images waiting on the scarce
Image quota never hold ALTO's slots. Image sizes are chosen per canvas from the
manifest's dims: Mistral `max` up to 4096 px on the long edge, else
`!4096,4096`; vision the same at 2048 (`src/bnf/image-size.ts`).

Each backfilled TEXT document costs one BnF ALTO call per indexed folio, once,
through the same ALTO gate as live ingests — the block above therefore sets
`OCR_BACKFILL_ENABLED=false`; turn it on only when you mean to spend that quota
(see `helm/DEPLOY.md`, "OCR quality backfill").

```bash
npm start                                # boots the worker (all stages long-poll forever)
npm run seed -- <projectId> <ark...>     # enqueue docs into the metadata bucket
npm run status -- <projectId>            # print the progress read-model (counts + ETA)
```

## Pull ARKs from the local DB (one per lane)

The app DB records each ingested document's ARK + docType + OCR availability. To
sample one ARK of each lane for the gates (adjust table/column names to the live
schema — `Document` in the app DB):

```sql
-- text lane: BnF has an OCR layer
SELECT ark FROM "Document" WHERE "ocrAvailable" = true LIMIT 4;
-- vision lane: visual docType
SELECT ark FROM "Document" WHERE "docType" ILIKE ANY (ARRAY['%estampe%','%carte%','%image%']) LIMIT 4;
-- mistral lane: digitized text, no OCR layer (sans_texte)
SELECT ark FROM "Document" WHERE "ocrAvailable" = false
  AND "docType" NOT ILIKE ANY (ARRAY['%estampe%','%carte%','%image%','%photograph%']) LIMIT 4;
```

## The three gates (from the goal)

1. **1 doc per lane + error spikes.** Seed one text + one vision + one mistral ARK.
   Confirm each reaches `done` (`npm run status`). The 500/502/permanent handling is
   already proven in `src/integration.test.ts`; against live BnF you're confirming
   the *real* clients parse/route correctly.
2. **10 docs per lane** (ARKs from the query above). Confirm all reach a terminal
   state and the counts reconcile.
3. **80-doc run.** Confirm the BnF fetch bucket sustains the rate cap on all
   channels, the observability counters + ETA are correct, retries recover, and
   failures are isolated (no doc holds a slot hostage — the V1 killer).

## Security posture

The worker's HTTP ingress (`POST /ingest`, `POST /ingest/:id/cancel`,
`POST /ocr-quality/sync`) has **no authentication of its own** — it trusts the
cluster network (any pod that can reach `:7777` can open or cancel a run, or ask
for OCR-quality artifacts). `/ocr-quality/sync` can at most enqueue rate-gated,
idempotent artifact builds, one row per ARK, with bounded retries (plan D17); its
body is capped at 16 KiB, the whole request (body read included) at 20 s — under the
app's 30 s `WORKER_RUNNER_TIMEOUT_MS` — and at most 2 requests are served at once. The broker it talks to has the same
posture (see `../broker/README.md`). The one thing that IS authenticated is
the terminal callback the worker POSTs back to the app: it's HMAC-signed
(`x-callback-signature`, per-run secret) and the app verifies it byte-for-byte.
This is accepted for the demo deployment — flagged for ISO 27001 work (F22,
`ai-memories/tech/repos/bnf/ingest-hardening`).

## ⚠️ Safety constraints (do NOT skip)

- **The BnF ingestion quotas are shared by everything behind the broker.**
  Never run a gate while anything else is ingesting against the same broker — a
  concurrent burst trips a quota (freeze) and poisons both runs. Pick a quiet
  window.
- **The global cap is the binding one and is not yet measured** (1000/min, maybe
  1500 since the API split — the Track D ramp test settles it). Do not raise
  `BNF_GLOBAL_RPM` past the broker's `rates.global.rpm`.
- **The broker is hard-pinned to one replica.** Never scale it (in-memory buckets
  + per-IP caps).
- **Mistral is a paid, budget-capped operation.** `MISTRAL_OCR_ENABLED=true` runs
  paid OCR for every `sans_texte` doc seeded — the app's spend confirmation is the
  upstream gate; seeding mistral-lane ARKs here bypasses it, so keep the gate runs
  small and watch the spend.
