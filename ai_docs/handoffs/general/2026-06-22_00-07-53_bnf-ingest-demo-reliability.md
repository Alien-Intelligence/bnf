---
date: 2026-06-21T22:07:53+0000
researcher: Claude Code (Opus 4.8)
git_commit: d9bd092d95b41adc94eaee2524933c979099e59e
branch: feature/langfuse-tracing
repository: datastreaming-demos
topic: "BnF ingest pipeline — demo-reliability hardening"
tags: [implementation, ingestion, bnf, worker, retry, backoff, gallica, vision, reliability, demo-prep]
status: complete
last_updated: 2026-06-21
last_updated_by: Claude Code
type: implementation_strategy
---

# Handoff: BnF ingest pipeline — works end-to-end, NOT yet demo-reliable

## Task(s)

**Context.** The async ingest worker (now `bnf/worker/`, promoted out of
`bnf/sandbox/bnf-ingest/` and committed in `d9bd092`) ingests a BnF corpus:
Gallica OCR/vision → chunk → RunPod embed → index into data-cluster 158. Over
this session it went from "stub/sandbox" to functionally working end-to-end and
driven from the app's "Lancer l'ingestion" button.

**Completed this session:**
- ✅ Worker is MCP-free and self-contained; vendored vision client.
- ✅ **OCR primary = Gallica viewer scrape** (`worker/src/prepare/viewer-ocr.ts`),
  ALTO is fallback. Sidesteps the 5/min ALTO quota (a doc that took ~5 min now
  ~5 s).
- ✅ **Vision: Holo2 primary (raw fetch) + Gemini `gemma-4-31b-it` fallback.**
- ✅ Cluster HTTP hardened (timeout + retry + fresh-connection agent).
- ✅ App ingest progress fixed: 4 stage bars compute from per-doc counters; the
  runner emits `embedding`/`indexing` transitions (real staircase); live ETA;
  legacy `fraction×100` bug fixed.
- ✅ Promoted worker to `bnf/worker/` (tracked; `.env` stays gitignored). Commit
  `d9bd092`.

**THE OPEN PROBLEM (why this handoff exists):**
🔴 **The pipeline is not demo-reliable.** Two app-triggered runs (27 docs, then
+10 docs) each *looked hung* and required **manual DB/pg-boss nudging** to
finish. Root causes below. The next agent must make it run start→finish with
**zero manual intervention**. This is the priority.

## Critical References

- `bnf/worker/src/queue/runner.ts` — per-doc state machine, retry/terminal logic
  (`MAX_DOC_JOB_ATTEMPTS = ingest.retryLimit()+1`).
- `bnf/worker/src/queue/orchestrator.ts` — pg-boss enqueue: `retryLimit`,
  `retryDelay`, `retryBackoff:true`, `expireInSeconds`.
- `bnf/worker/src/prepare/bnf-api.ts` — Gallica HTTP (OAIRecord, Pagination,
  ALTO, manifest); `classifyStatus()` maps HTTP→Transient/Permanent.
- `bnf/worker/src/env.ts` `ingest` slice — `INGEST_RETRY_LIMIT=5`,
  `INGEST_RETRY_DELAY_SECONDS=120`, `MAX_OCR_PAGES=1000`.
- `bnf/playbook/ingestion-jobs.md`, `bnf/design/docs/07-ingestion-jobs-and-corpus-delta.md`.

## Recent changes

All under `bnf/worker/` (committed `d9bd092`) + app:
- `worker/src/prepare/vision.ts` — Holo via raw undici `request()` (NOT the
  OpenAI SDK — see Learnings); Gemini fallback; `VISION_PRIMARY` env (=`holo`).
- `worker/src/prepare/viewer-ocr.ts` — viewer-OCR harvester (primary OCR).
- `worker/src/prepare/bnf-api.ts` — `getDocumentText` tries viewer then ALTO;
  split rate limiters (`altoRateLimit` strict 5/min, `gallicaRateLimit` general
  8 rps).
- `worker/src/queue/runner.ts:248-280` — `onStage` callback → emits
  `embedding`/`indexing` transitions.
- `worker/src/cluster/http.ts` — timeout + transient retry + dedicated Agent.
- `bnf/components/cards/ingest/stage-pipeline.tsx` — counter-based stage bars + ETA.
- `bnf/docker-compose.yml`, `bnf/tsconfig.json` — worker moved to `./worker`.

## Learnings

- 🔴 **Retry backoff makes transient Gallica errors look like a hang.**
  `INGEST_RETRY_DELAY_SECONDS=120` with `retryBackoff:true` → retries at
  120/240/480/960/1920 s. A doc that hits a transient `ECONNRESET`/`5xx` on
  Gallica sits "awaiting_retry" for minutes; the UI shows a frozen %. Both demo
  runs stalled this way and I had to `UPDATE pgboss.job SET start_after=now()`
  to move them. **Fix: drop the base delay (e.g. 15–20 s) and/or cap backoff for
  the demo.** Env-only (`INGEST_RETRY_DELAY_SECONDS`) — no code change needed to
  start.
- 🔴 **`cb…` ARKs are catalogue notices, NOT digitized documents.** They have no
  pages, so `Pagination` (and the viewer endpoint) `ECONNRESET` every time.
  Today the pipeline treats that as *transient* → retries 6× over ~1 h, then
  fails. They should **fail fast** (classify as permanent/skip on first
  Pagination reset for a `cb*`/non-digitized ARK). Two of the +10 docs were
  `cb*` and that's what wedged the second run. They also **shouldn't be
  submittable to ingestion** — the corpus already flags catalogue notices
  non-ingestable, but the ingest submission doesn't exclude them (product gap).
- 🔴 **Gallica throttles our egress IP under load.** Bursts of image fetches +
  the batch caused `ECONNRESET`/`server_error` on OAIRecord/Pagination. The
  general limiter is 8 rps; transient handling exists but the backoff (above)
  turns it into apparent hangs. (My own ad-hoc image-fetch testing aggravated
  this — worth knowing when reproducing.)
- ✅ **The OpenAI Node SDK (v4.104) is incompatible with Scaleway's chat
  endpoint** — every call returns "Premature close". Holo MUST be called over
  raw `fetch`/undici `request` with a JSON string body. Python/httpx works.
  This was misdiagnosed earlier as a "Scaleway outage". See
  `worker/src/prepare/vision.ts` header comment.
- ✅ **Gemini `gemma-4-31b-it` is capped ~15 img/min** (16k input-tok/min). It's
  the fallback only; Holo (higher quota) is primary, so this isn't on the hot
  path — but if Holo ever fails and Gemini takes over under concurrency, it 429s
  and drops canvases.
- Progress counters come from `SELECT status, COUNT(*) … GROUP BY status` in
  `worker/src/queue/callback.ts`; app stores them in `ingest_job.stats` and the
  UI derives the 4 bars from there (`stage-pipeline.tsx`).

## Artifacts

- Commit `d9bd092` (worker promotion + progress/ETA).
- `bnf/worker/**` (whole worker).
- `bnf/components/cards/ingest/stage-pipeline.tsx`
- Prior handoff: `bnf/ai_docs/handoffs/general/2026-06-20_18-12-29_bnf-ingest-pipeline.md`
- Memory: `bnf-ingest-worker-self-contained` (in the project memory index).

## Action Items & Next Steps

**Priority: make a full corpus ingest run start→finish with NO manual nudging.**

1. **Fail-fast on non-ingestable ARKs.** In `bnf-api.ts`, when an ARK has no
   digitization (catalogue `cb*`, or repeated `Pagination`/viewer `ECONNRESET`
   with no OCR signal), classify as **permanent** → skip immediately instead of
   transient-retrying. Add a skip reason like `not_digitized`.
2. **Tune retry for the demo.** Lower `INGEST_RETRY_DELAY_SECONDS` to ~15–20 s
   and consider capping the exponential backoff (a stuck doc shouldn't disappear
   for 30 min). Env-only to start; verify in `runner.ts`/`orchestrator.ts`.
3. **Exclude catalogue notices from the ingest submission** (app side) so `cb*`
   ARKs never enter the queue — they're flagged non-ingestable in the corpus
   already; the ingest selection should honor that.
4. **Distinguish "failed-permanent" from "retrying" in the UI** so a non-
   ingestable doc reads as skipped, not a frozen bar.
5. **Re-run the full demo corpus** end-to-end and confirm zero manual
   intervention + a clean terminal state. Watch `docker compose --profile worker
   logs ingest-worker -f`.
6. (Lower priority) Gallica politeness: confirm 8 rps general limiter doesn't
   trip IP throttling on a real run; lower if needed.

## Other Notes

- **Run state (this session):** last app job `done` — 5 ingested, 3 skipped, 2
  failed (the 2 `cb*` notices). Cluster 158, datasets created for `bnf-*`
  projects + app project ids; entries up to ~71.
- **Worker ops:** healthy on `:7777`, `VISION_PRIMARY=holo`, `MAX_OCR_PAGES=1000`,
  `WORKER_CONCURRENCY=8`, `IMAGE_CONCURRENCY=8`. Rebuild after worker code edits:
  `cd bnf && docker compose --profile worker build ingest-worker && docker
  compose --profile worker up -d ingest-worker`.
- **DB:** Postgres `:5437` `bnf_dev` (`bnf_user`/`bnf_dev_password`). Worker
  tables in schema `sandbox_ingest` (job + doc-job); app's Prisma job in
  `public.ingest_job`; pg-boss in schema `pgboss` (queue `bnf.ingest.doc`).
- **Manual nudge used this session (anti-pattern to eliminate):**
  `UPDATE pgboss.job SET start_after=now() WHERE name='bnf.ingest.doc' AND
  state='retry';` and forcing terminal via `UPDATE document_ingest_job SET
  attempts=5 …`. The whole point of the next pass is to never need this.
- **Uncommitted:** the repo has ~55 other dirty files (other projects + unrelated
  BnF i18n/app work) that are NOT mine — leave them. `messages/{en,fr}.json` still
  carry unrelated pre-existing i18n alongside the (committed) eta keys.
