# Worker V2 — running it + the integration gates

Worker V2 is a **staged dataflow pipeline of durable pg-boss buckets** (design:
`../../ai-memories/tech/repos/bnf/worker-v2-pipeline/plan/v2-architecture-design.md`).
This doc covers running it locally and the three acceptance gates from the goal.

## What's tested without any infra

```bash
npm test          # 100+ unit tests + a full fake-mode integration run
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
BNF_BROKER_URL=…                         # the egress chokepoint (owns OAuth + the rate caps)
BNF_GLOBAL_RPM=300                       # fetch rate gate (→ 1000 only if the per-IP raise lands)
BNF_FETCH_CONCURRENCY=12
BNF_MANIFEST_RPM=42
MISTRAL_OCR_ENABLED=true                 # + MISTRAL_API_KEY … (mistral lane)
# vision: SCW_API_KEY/SCW_GENAI_BASE_URL/HOLO_MODEL + GOOGLE_AI_API_KEY  (see src/live/*)
# embed:  RunPod creds;  cluster: CLUSTER_* (mirrors V1 env.ts names)
```

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

## ⚠️ Safety constraints (do NOT skip)

- **The BnF credential is shared (300/min via the broker).** Never run a gate
  while anything else is ingesting against the same broker — a concurrent burst
  trips the shared quota (freeze) and poisons both runs. Pick a quiet window.
- **The 1000/min raise is per egress IP and unconfirmed for the run IP.** The dev
  IP measured ~310/min with real freezes; the prod egress IP (`51.15.218.49`) is
  the one Ludo may have raised. Confirm before tuning `BNF_GLOBAL_RPM` above 300,
  or the 80-doc run will hit freezes (Open Question #2 in the design).
- **The broker is hard-pinned to one replica.** Never scale it (in-memory buckets
  + per-IP caps).
- **Mistral is a paid, budget-capped operation.** `MISTRAL_OCR_ENABLED=true` runs
  paid OCR for every `sans_texte` doc seeded — the app's spend confirmation is the
  upstream gate; seeding mistral-lane ARKs here bypasses it, so keep the gate runs
  small and watch the spend.
