---
date: 2026-06-20T18:12:29+0200
researcher: Claude Code (Opus 4.7)
git_commit: 0d44bc0e5cd480c0c9fbd9801f2a516afbbc0158
branch: feature/bnf-app
repository: datastreaming-demos
topic: "BnF Corpus Research — Ingestion Pipeline E2E + BnF Rate-Limit Findings"
tags: [implementation, ingestion, bnf, gallica, pg-boss, docker, rate-limit, holo2, runpod, demo-prep]
status: complete
last_updated: 2026-06-20
last_updated_by: Claude Code
type: implementation_strategy
---

# Handoff: BnF ingestion pipeline — Pass 1→3 done, demo-prep bugs remaining

## Task(s)

**Overall objective**: build the async ingestion pipeline for the BnF Corpus Research demo so that "Lancer l'ingestion" in the Next.js app actually triggers OCR/Holo2 description fetching, embedding, and indexing into a data-cluster RAG store. Demo deadline: **Tuesday (3 days)**.

**Completed**:
- ✅ **Track 1 (prepare)** — direct Gallica HTTP client (Pass 2 replaced the BnF MCP layer with `bnf-api.ts`) covering OAIRecord metadata, Pagination + ALTO OCR fetch, IIIF manifest fetch, IIIF image URL. Multi-canvas image documents supported (each canvas → its own folio chunk with `iiif_url` for citation).
- ✅ **Track 2 (queue/runner)** — pg-boss queue (`bnf.ingest.doc`), per-doc state machine in `sandbox_ingest.document_ingest_job`, content-hash short-circuit, upsert-by-slug (delete + recreate on hash mismatch).
- ✅ **Track 3 (embed + cluster)** — RunPod bge-m3 (1024-dim) embedder, full create-entry → upload → save-processed → index-chunks flow against cluster 158 on `https://api.alpha.alien.club`.
- ✅ **App ↔ worker HTTP wiring** — `ClusterClient.submit` real-mode POSTs `ClusterIngestRequest` to worker `:7777`; worker sends HMAC-signed `ClusterProgressEvent` callbacks back to `POST /api/internal/ingest/:job_id/progress`. End-to-end "click Lancer → cluster has new entries → status flips to done" proven against real cluster (Hugo discourse, entry id=2, 2 chunks, 1.88s).
- ✅ **Docker worker** — `restart: unless-stopped` + `tini` PID 1 + `host.docker.internal` host-gateway for native Linux callback to app on `:3001`. Auto-restart on crash verified (`RestartCount: 1` after SIGSEGV).
- ✅ **Pass 3 robustness fixes** — process-wide token-bucket rate limiter (`src/prepare/rate-limiter.ts`), submit-side jitter (`orchestrator.ts` `startAfter: uniform[0, N*0.4]s`), new `awaiting_retry` status, per-doc page-fail ceiling (>25% fail → `rate_limited_doc`), worker scripts swapped to per-job `boss.fail()` so pg-boss retry policy actually fires.
- ✅ **Gallica rate-limit empirically characterized**: 5 requests / ~30–60s window on `RequestDigitalElement?E=ALTO`. Matches documented 5/min IIIF Image quota (`api.bnf.fr`). Current env: `GALLICA_RPS=0.083, GALLICA_BURST=5`.

**In progress / discussed**:
- 🟡 **Bug #2 — OAIRecord 400 fallback to IIIF manifest**: Some ARKs (esp. Cartes & Plans, Estampes, specialist series) are viewable on Gallica IIIF but have no OAIRecord entry. Today `getDocumentInfo` returns `PermanentBnfError → SkipReason("mcp_unavailable")` for them, killing what could be ingestable image-only docs. Fix: on OAIRecord 400, fall back to fetching IIIF manifest and deriving title/creator/date from `manifest.metadata[]`. ~30 min of code. **Not yet implemented**.
- 🟡 **Bug #4 — Holo failure on image-only docs**: Pass 3 robustness test had 3 image docs all skip with `holo_failed`. Same Chéret affiche worked perfectly in the `sandbox/bnf-images/` smoke run earlier. **Root cause not yet investigated** — three hypotheses: env var not propagated to container, image fetch from inside container blocked, Scaleway Holo endpoint flake.
- 🟡 **5-doc smoke test at proper rate (5/min)**: parent job still `running` in DB at handoff time. 3 docs `skipped` (1 OAIRecord 400, 1 missing OCR signal, 1 holo_failed). 2 docs still extracting (Hugo discourse on `attempts=2` after cluster-connection-died "other side closed" retry; Hugo Feuilles d'automne grinding through 328 pages at 5/min). Verifies rate limiter works correctly but corpus choice was wrong (poetry book ≠ small doc).
- 🟡 **Email drafted to BnF API team** (`gallica@bnf.fr`) asking for elevated quota / bulk OCR export / token. User to send. French, informal — see Other Notes for content.

**Planned (post-demo)**:
- Pass 4: AIMD adaptive rate limiter (multiplicative-decrease on 429), longer pg-boss `retryDelay` (300s), `MAX_OCR_PAGES` ceiling on long books.
- Investigate the "submit script returned wrong ingest_job_id" oddity flagged in Pass 3 — possible search_path collision between `public.ingest_job` (app) and `sandbox_ingest.ingest_job` (worker) in shared `bnf_dev` DB.

## Critical References

- `bnf/playbook/ingestion-jobs.md` — the rules that govern Track 2's contract (job lifecycle, idempotency, callback shape).
- `bnf/design/docs/07-ingestion-jobs-and-corpus-delta.md` — design intent (delta-based ingest, version pointers).
- `bnf/lib/cluster/contracts.ts` — the wire contract between app and worker (`ClusterIngestRequest`, `ClusterProgressEvent`).
- `bnf/sandbox/bnf-ingest/README.md` — full sandbox architecture overview.
- `api.bnf.fr/fr/api-document-de-gallica` — official Gallica API docs (documents the 5/min rate limit).

## Recent changes

Files in `bnf/sandbox/bnf-ingest/` (sandbox worker):
- `src/prepare/bnf-api.ts` — direct Gallica HTTP client replacing the MCP. ~715 LOC. OAIRecord XML parse, ALTO per-page concat, IIIF manifest parse.
- `src/prepare/errors.ts` — `TransientBnfError` / `PermanentBnfError` / `isTransient()`.
- `src/prepare/retry.ts` — `withBnfRetry()` exp backoff helper, 4 attempts, 60s wall cap, 5s base for 429.
- `src/prepare/rate-limiter.ts` — process-wide token bucket, env `GALLICA_RPS=0.083, GALLICA_BURST=5`.
- `src/prepare/extract.ts:204-280` — `extractImagePages` iterates manifest canvases, per-canvas Holo with 2-attempt retry on unparseable JSON.
- `src/prepare/index.ts:84-105` — `getDocumentInfo` permanent/transient classification at the prepare entry.
- `src/queue/runner.ts:230-290` — runner rethrows transient errors after writing `awaiting_retry` status; final attempt marks `failed`.
- `src/queue/orchestrator.ts` — submit-side jitter (uniform [0, N*0.4]s per pg-boss enqueue).
- `src/queue/types.ts` — added `"awaiting_retry"` to `DocumentIngestJobStatus` union.
- `src/queue/callback.ts` — HMAC callback emitter with 2s coalescing (Track 2 agent's work).
- `scripts/04-worker.ts:79-110` — per-job `boss.fail()` so pg-boss retries fire instead of being swallowed.
- `scripts/06-worker-api.ts:199-225` — same per-job `boss.fail()` pattern, plus HTTP `:7777` listener (POST `/ingest`, POST `/ingest/:id/cancel`, GET `/health`).
- `Dockerfile.worker` — `EXPOSE 7777`, `CMD ["npx","tsx","scripts/06-worker-api.ts"]`.
- `package.json` — removed `@modelcontextprotocol/sdk`, added `fast-xml-parser`.
- `.env` — added `GALLICA_RPS=0.083`, `GALLICA_BURST=5`, `WORKER_HTTP_PORT=7777`, `APP_BASE_URL=http://host.docker.internal:3001`.

Files in `bnf/` (Next.js app):
- `models/ingest/service.ts:108-117` — `WORKER_CALLBACK_BASE_URL` env override for callback URL (host.docker.internal in dev).
- `lib/cluster/client.ts` — real-mode `ClusterClient.submit` + `cancel` over HTTP (was a stub before).
- `lib/cluster/contracts.ts` — added `appJobId: string` to `ClusterIngestRequest`.
- `docker-compose.yml` — added `ingest-worker` service with `extra_hosts: host.docker.internal:host-gateway`, `network: bnf` (explicit), `restart: unless-stopped`, profile `worker`.
- `prisma/schema.prisma` migrations were already in place; applied with `prisma migrate deploy` to materialize `public.ingest_job`.
- `.env.local` — `CLUSTER_MODE=real`, `WORKER_RUNNER_URL=http://localhost:7777`, `WORKER_CALLBACK_BASE_URL=http://host.docker.internal:3001`.

## Learnings

- **Gallica's ALTO endpoint shares the 5/min IIIF quota** (empirically: bucket of exactly 5 then 30–60s cooldown, no `Retry-After` header). MCP works fine for chat-agent usage because it's invoked once per turn; batch pipelines hit the wall immediately. Confirmed via direct curl on multiple endpoints.
- **OAIRecord is incomplete** — many ARKs viewable on Gallica IIIF return HTTP 400 from `/services/OAIRecord`. Manifest fetch is the universal fallback for metadata. See `bnf-api.ts:getDocumentInfo` permanent-classification path.
- **`localhost:3001` from inside a Docker container ≠ host**. Use `host.docker.internal:host-gateway` in `extra_hosts` + `WORKER_CALLBACK_BASE_URL` env override on the app side.
- **pg-boss v10 batch handlers**: a single throw in the handler poisons the whole batch (all N jobs retried). Per-job control requires per-job `try/catch` + explicit `boss.fail(name, jobId, {error})`. Without this, the runner's transient throw didn't actually trigger pg-boss retries.
- **`sandbox_ingest` vs `public.ingest_job` schemas**: the sandbox worker uses a separate Postgres schema to avoid colliding with the Next.js app's Prisma-managed `public.ingest_job`. There's a suspected `search_path` quirk where `IngestOrchestrator.submit` returned an ID not matching the actual DB row — needs investigation.
- **Holo2 non-determinism**: same image describes slightly differently each call (different `contentHash`). Means content-hash short-circuit only fires for text-OCR re-ingests, never for image re-ingests. Image re-ingest path goes through `findEntryBySlug → deleteEntry → recreate` (works but pays full cost).
- **Worker zombies** are a real concern in dev (multiple workers from interactive `nohup &` sessions sharing the same pg-boss queue caused confusing "stub-returned" results once). Docker container fixes this — one worker per container, supervised, single source of state.
- **Don't infer rate limits from agent reports** — verify with curl. Subagent reports compress reality; direct probing surfaces actual server behavior. Lesson learned the hard way today.

## Artifacts

**Implementation (sandbox worker)**:
- `bnf/sandbox/bnf-ingest/src/prepare/{bnf-api,errors,retry,rate-limiter,extract,chunk,render,hash,index}.ts`
- `bnf/sandbox/bnf-ingest/src/queue/{orchestrator,runner,repo,boss,callback,migrate,types,schema.sql,index}.ts`
- `bnf/sandbox/bnf-ingest/src/cluster/{client,upsert,http,dataset,index}.ts`
- `bnf/sandbox/bnf-ingest/src/embed/runpod.ts`
- `bnf/sandbox/bnf-ingest/src/blob/{interface,local,s3,index}.ts`
- `bnf/sandbox/bnf-ingest/scripts/{04-worker,05-submit,06-worker-api,01-prepare-one,02-embed-one,03-register-one}.ts`
- `bnf/sandbox/bnf-ingest/Dockerfile.worker`
- `bnf/sandbox/bnf-ingest/tests/robustness-pass3.md` — Pass 3 robustness test results

**App side**:
- `bnf/lib/cluster/{client,runner,contracts,callback-auth,fake}.ts`
- `bnf/models/ingest/{service,queries,policy,schema,types}.ts`
- `bnf/app/api/{projects/[id]/ingest,ingest/[job_id]/route,ingest/[job_id]/cancel,internal/ingest/[job_id]/progress}/route.ts`
- `bnf/app/[locale]/projects/[projectId]/ingerer/{page,client}.tsx`
- `bnf/docker-compose.yml` (root-level, drives both postgres + ingest-worker)

**Reference docs**:
- `bnf/playbook/ingestion-jobs.md`, `bnf/playbook/corpus-versioning.md`
- `bnf/design/docs/07-ingestion-jobs-and-corpus-delta.md`
- BnF demo email draft: see Other Notes below

## Action Items & Next Steps

**Immediate (to unblock Tuesday demo)** — in priority order:

1. **Investigate Bug #4 (Holo failure)**. Quick diagnostic in this order:
   - `docker exec bnf-ingest-worker-1 env | grep -E '^(SCW_|HOLO|GEMMA|PIXTRAL)'` — verify env vars are in the container.
   - From the container, `wget -O- 'https://gallica.bnf.fr/iiif/ark:/12148/btv1b9015469h/f1/full/!1280,1280/0/native.jpg'` — verify image fetch works from container's network.
   - From host, run `cd bnf/sandbox/bnf-images && npm run smoke` (the image describe test that was working earlier today) — verify Scaleway Holo endpoint still responds.
   - If env is missing in container: pass them through in docker-compose `env_file` or `environment`.

2. **Implement Bug #2 (manifest fallback)** in `bnf/sandbox/bnf-ingest/src/prepare/bnf-api.ts:getDocumentInfo`. When OAIRecord throws `PermanentBnfError("bad_ark")` from 400, catch it and try `getManifest(ark)` instead. If manifest succeeds, build a `BnfDocInfo` from `manifest.metadata[]` (title/creator/date) with `ocrAvailable: false` and `docType: "image"` (so it routes to the image_pages path). Rebuild Docker after.

3. **Pre-ingest demo corpus** — once #1 + #2 are fixed, pick ~30 small documents (short pamphlets, discourses, AND image-only docs: estampes, cartes, affiches) and submit overnight. Image-only docs are FAST (no per-page ALTO loop, just Holo on N canvases — and Holo isn't BnF-rate-limited).

4. **Send the BnF email** (drafted in Other Notes) to `gallica@bnf.fr` asking about elevated quota / bulk export. This is a longer-term unlock for the 1500-doc target.

**Defer to post-demo**:

5. Pass 4 — AIMD rate limiter, longer pg-boss retryDelay, MAX_OCR_PAGES ceiling.
6. Investigate the `IngestOrchestrator.submit` returning wrong ID (Pass 3 flagged this — possible `search_path` collision with `public.ingest_job`).
7. Cancel propagation — Track 2 agent flagged: `ClusterRunner.cancel` is wired DB-side but the runner doesn't consult `isCanceled()` before launching each per-doc job.

## Other Notes

**Current Docker worker state**:
- Container `bnf-ingest-worker-1` running on `:7777`, healthy as of handoff. Uses `06-worker-api.ts` (HTTP + pg-boss in one process).
- Env: `GALLICA_RPS=0.083, GALLICA_BURST=5, WORKER_CONCURRENCY=4, IMAGE_CONCURRENCY=3, MAX_IMAGE_CANVASES=5` (lowered for tests).
- Postgres on `:5437`, db `bnf_dev`, user `bnf_user`/`bnf_dev_password`.
- App dev server on `:3001` (not `:3000`).

**Cluster state on alpha**:
- Cluster ID 158, base `https://api.alpha.alien.club/clusters/158/proxy`
- Dataset 1 (`bnf-demo-project`), 2 entries (`bpt6k58022059` Hugo discourse + `btv1b11600025m` Exposition album), 14 Qdrant points
- vector_size=1024 (bge-m3 compatible)
- BEARER: in `bnf/.env.local` as `CLUSTER_BEARER_TOKEN` (alpha admin token `oat_Mjg...`)
- BnF MCP token: in `bnf/.env.local` as `BNF_MCP_TOKEN` (`oat_Nzc...`) — same user but no longer used by worker (Pass 2 dropped MCP)

**BnF email draft** (to send to `gallica@bnf.fr`, salutation TBD by user):

> **Objet :** Quota ALTO pour la démo de mardi
>
> Salut !
>
> Petit point côté technique pour la démo **Corpus Research** mardi : tout est en place, sauf qu'on se fait taper par le **quota de 5 req/min sur `RequestDigitalElement?E=ALTO`** (qui correspond à celui documenté pour l'API Image IIIF, je suppose qu'ALTO partage le bucket).
>
> À ce rythme, le corpus de ~1500 docs prend plusieurs jours juste pour récupérer l'OCR. Tout le reste (OAIRecord, Pagination, manifestes IIIF) passe sans pb.
>
> Trois options, par ordre de préférence :
>
> 1. Un **token applicatif** pour qu'on ait un quota plus élevé sur ALTO le temps de la démo (et au-delà si le partenariat le permet) ?
> 2. Un **export bulk** de l'OCR pour les ARKs qui nous intéressent — un peu comme les jeux "OCR corrigé presse" ou "TEI Obvil", mais sur monographies ? Si vous avez un dump qu'on peut récupérer une fois (S3, FTP, OAI-PMH...), c'est l'idéal pour de l'ingestion bulk.
> 3. À défaut, on cale notre rate limiter à **5 req/min strictes** et on prévient le client que la première ingestion prend ~3–4 jours.
>
> Le User-Agent applicatif est `bnf-ingest/0.1 (leo@alien.club)` si vous voulez tracer.
>
> Merci 🙏
> Leo

**How to resume the running 5-doc test**:
- Parent ingest_job: latest row in `sandbox_ingest.ingest_job` (status was `running` at handoff)
- 2 docs still active: `bpt6k58022059` (Hugo discourse, attempts=2, retried after "other side closed"), `bpt6k62084617` (Hugo Feuilles, 328 pages — will take ~50min at 5/min)
- Watch with: `docker compose logs ingest-worker --tail=20 -f` and `PGPASSWORD=bnf_dev_password psql -h localhost -p 5437 -U bnf_user -d bnf_dev -c "SELECT ark,status,attempts FROM sandbox_ingest.document_ingest_job WHERE ingest_job_id=(SELECT id FROM sandbox_ingest.ingest_job ORDER BY created_at DESC LIMIT 1)"`

**Docker rebuild after code changes** (because Node doesn't hot-reload inside containers):
```bash
cd bnf
docker compose --profile worker down ingest-worker
docker compose --profile worker build ingest-worker
docker compose --profile worker up -d ingest-worker
curl http://localhost:7777/health   # → {"ok":true}
```

**Sandbox layout reminder**:
- `bnf/sandbox/bnf-images/` — earlier Holo2/Pixtral vision feasibility sandbox (~1500 LOC). The `describeImage()` function from here is dynamically imported by the worker's image path. If Holo is broken, smoke test this sandbox first.
- `bnf/sandbox/bnf-ingest/` — the production ingestion pipeline (sandbox of the prep+queue+register pipeline that the worker container actually runs).
