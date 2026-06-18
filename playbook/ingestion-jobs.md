# Ingestion Jobs Rule

## Rule

Ingestion is **asynchronous, long-running, and incremental**. The backend MUST
run jobs out-of-process, report progress in four stages, operate on the
corpus **delta** between the last-ingested version and the chosen target, and
remain idempotent under retry. This is a hard client requirement — see
[doc 07](../design/docs/07-ingestion-jobs-and-corpus-delta.md).

## Boundaries

- **This app owns** the job orchestration: submission, queuing, status,
  retries, cancellation, progress reporting, and the bookkeeping of
  `corpus_version` pointers.
- **The cluster team owns** ⛔ the custom fast chunk/embed/index scripts and
  the cluster's write/query APIs. The app **invokes and monitors** those
  scripts through a contract documented below.
- The **embedding model** is fixed per cluster and is **not** an app concern
  to choose. Re-embedding on a model change is a **full re-ingest** —
  triggered by an explicit migration job, not by an everyday corpus edit.

## The job lifecycle

```
queued → running → done
                ↘ failed
                ↘ canceled
```

Stages within `running`:

```
extract → chunk → embed → index → commit
```

`commit` is internal to this app (advance pointers, mark version `ingested`).
The four stages above are what the UI shows (matches the prototype's
four-row pipeline view).

## The job submit flow

```ts
// app/api/projects/[id]/ingest/route.ts
export const POST = withAuth(async (req, user, bouncer, ctx) => {
  const { id: projectId } = await ctx.params
  const parsed = await parseBody(req, ingestSubmitSchema)   // { targetVersionSeq?: number }
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound()
  await bouncer.with(IngestPolicy).authorize("submit", project)

  const job = await IngestService.submit(project, user, parsed)
  return ok<IngestJob>(job)
})
```

`IngestService.submit`:

1. Resolves `target = head` (or the explicitly requested seq).
2. Resolves `base = project.ingestedVersionId ?? null`.
3. Computes the delta: `added = membership(target) - membership(base)`,
   `removed = membership(base) - membership(target)`. For first ingest,
   `added = full membership(target)`.
4. **Deduplication** ✅ — if a job already exists for `(projectId, targetVersionId)` in
   `queued|running` state, returns that job (same `id`, no new row). This is the
   "submit twice = one job" idempotency required by [doc 07](../design/docs/07-ingestion-jobs-and-corpus-delta.md#job-runner-requirements).
5. **No-op short-circuit** ✅ — if `added.length === 0 && removed.length === 0`,
   create a `done` job that just advances `ingestedVersionId` (the
   "advance bookkeeping" case).
6. Inserts the `ingest_job` row with `status = queued`, `stage = null`,
   `added_count`, `removed_count`, `targetVersionId`, `baseVersionId`.
7. Enqueues the job onto the runner.

## The runner contract

The runner technology is 🔶 (a queue + worker framework, a workflow engine,
or the cluster's own batch system). What the runner **must** provide is the
contract — not the implementation.

```ts
// lib/jobs/runner.ts (the app's view of the runner)
export interface JobRunner {
  enqueue(job: IngestJobSpec): Promise<void>
  cancel(jobId: string): Promise<void>
  // Workers consume jobs and call back into the app via:
  //   POST /internal/ingest/:job_id/progress    { stage, fraction, counters }
  //   POST /internal/ingest/:job_id/result      { chunksWritten, stats, error? }
  // These internal routes are authenticated with a shared secret; not exposed publicly.
}
```

What `IngestJobSpec` carries to the worker:

```ts
type IngestJobSpec = {
  jobId: string
  projectId: string
  targetVersionId: string
  baseVersionId: string | null
  addedArks: string[]
  removedArks: string[]
  callbacks: { progressUrl: string; resultUrl: string; secret: string }
}
```

The worker then invokes the cluster's custom ingest script with that input
and posts progress / final result back over the callback URLs.

## The cluster ingest script contract ⛔

This is the contract the cluster team implements:

```
run_ingest(
  project_id, index, added_docs[], removed_arks[], progress_cb
) -> { chunks_written, stats }

added_docs[i] = { ark, text | text_ref, folio_map, metadata }
progress_cb(stage, fraction, counters)
```

Rules the app enforces around this contract:

- The script is invoked **once per job** and runs to completion (or failure).
- Stages it must emit, in order: `"extract"`, `"chunk"`, `"embed"`, `"index"`.
- Each `progress_cb` call reaches the app within ~10s of a meaningful state
  change. The app's `IngestJob.progress` is updated; the SSE / poll endpoint
  surfaces it.
- The script **must preserve folio** as chunk metadata. This is what makes
  `rag.query` carry a citable folio (see [citations.md](citations.md)).
- The script may report per-doc failures inside `stats.docErrors[]`; the job
  as a whole succeeds as long as the script returns. The app does **not**
  fail a whole job on a single OCR failure — that's documented in
  [doc 07 § Job runner requirements](../design/docs/07-ingestion-jobs-and-corpus-delta.md#job-runner-requirements).

## Idempotency and resumability

- **Job dedupe by `(project_id, target_version_id)`** — only one job per
  target version may be in flight. A retry that hits this guard returns the
  existing job. (Implementation 🔶: a partial unique index on `ingest_job`
  filtered to `status IN ('queued','running')`.)
- **Chunk-level idempotency** — the cluster script writes vectors keyed by
  `(project_id, ark, folio, chunk_hash)`; re-running on the same docs
  upserts. The app does not need to track chunk-level state itself.
- **Removed-ARK tombstones** — the script issues delete-by-ARK to the index
  for each `removedArks` entry. The app does not retain "ghost" vectors.

## The commit step

Only `IngestService.commit(job, results)` advances `project.ingestedVersionId`.
See the example in [corpus-versioning.md](corpus-versioning.md). The commit
is a single Prisma transaction so the three writes (job done, version
ingested, project pointer) happen atomically.

## Cancellation

`POST /api/ingest/:job_id/cancel` flips the job to `canceled` and calls
`runner.cancel(jobId)`. The cluster script must observe its own cancellation
signal and stop within ~30s 🔶. Partial writes are tolerated:

- Vectors written for the canceled job's `addedArks` may remain in the index.
  They are unreferenced by `project.ingestedVersionId` (still pointing at
  `base`) so `rag.query` does not return them — *but* a future job for a
  superset target will treat them as already-written (chunk idempotency).
- The next successful job reconciles: chunks for ARKs still in the corpus
  remain; the index is left consistent.

## Progress reporting

The UI consumes progress in one of two ways:

- **SSE** (🔶 preferred) — `GET /api/ingest/:job_id/stream` returns
  `text/event-stream` with the same shape as the JSON poll response on each
  meaningful update. Same disconnect/resume tolerance as agent streams.
- **Poll** — `GET /api/ingest/:job_id` returns a snapshot. The client polls
  every `INGEST_POLL_INTERVAL_MS` (see [constants.md](constants.md)) while
  `status ∈ {queued, running}` and stops on a terminal state.

The poll response shape ✅:

```ts
// models/ingest/types.ts
export type IngestStatusResponse = {
  status: IngestStatus
  stage: IngestStage | null
  progress: number          // 0..1 overall
  addedCount: number
  removedCount: number
  chunksWritten: number
  etaSeconds: number | null
  stages: {
    key: IngestStage
    status: "pending" | "running" | "done" | "failed"
    fraction: number
  }[]
  error: string | null
}
```

The `stages[]` array always has four entries in fixed order (extract, chunk,
embed, index) so the UI always renders all four rows. A stage not yet started
is `{ status: "pending", fraction: 0 }`.

## UX during a long job — "come back later"

While `status = running`, the Ingest page shows:
- The four-row pipeline (`CardIngestStagePipeline`) with live fractions.
- A banner — "Le traitement continue côté serveur. Vous pouvez revenir plus
  tard." — implemented as `<AlertIngestComeBackLater />`.
- The current overall percent and the ETA when available.

When `status = done`, the page swaps to a completion state that hands off
to Research (`<CardIngestComplete />` with a CTA to `ROUTES.rechercher(projectId)`).

On `failed`, an `AlertIngestFailed` shows the error and offers retry.

## One active ingest per project (🔶 recommended)

Serialize ingests per project so `ingestedVersionId` advances monotonically.
Enforced via a unique index:

```prisma
@@unique([projectId, status], name: "one_active_per_project",
         map: "ingest_job_one_active_per_project_uidx",
         where: { status: { in: ["queued", "running"] } })
```

(In Prisma SQL: a partial unique index. The app fails fast with a clear
error rather than queuing two parallel jobs.)

## Model-change re-ingest

Changing the embedding model is **not** a delta. It is a separate operation:

```ts
// IngestService.fullReingest(project, newModelTag)
```

Which: creates a new "model migration" job that targets `head` with
`base = null` (treating every doc as new), invokes a special script flag
`--reembed-only`, and on success swings `ingestedVersionId` once the new
embeddings replace the old. Until then `rag.query` continues to use the
old index 🔶. This is a documented, manually-triggered path — not something
agents or normal users do.

## Forbidden patterns

```ts
// ❌ Inline OCR/chunk/embed in a route handler
const text = await tesseract(ark)
const chunks = chunk(text)
const vectors = await embed(chunks)
// → never; this is a multi-hour job, not a request

// ❌ Synchronous wait on a job from a route handler
const job = await IngestService.submit(...)
while (job.status === "running") { await sleep(...); job = ... }
return ok(job)
// → return the job_id; the client polls or subscribes

// ❌ Mutating ingestedVersionId from anywhere other than commit()
await prisma.project.update({ data: { ingestedVersionId: ... } })

// ❌ Letting a single bad document fail the whole job
if (oneOcrFailed) throw new Error("ingest failed")
// → record in stats.docErrors[], continue

// ❌ Calling rag.query during an in-flight ingest against the target version
// → rag targets ingestedVersionId; nothing else
```

## Relation to other rules

- [corpus-versioning.md](corpus-versioning.md): defines `head` /
  `ingestedVersionId` invariants and `advanceVersion()`. Ingest never creates
  versions — it only consumes them and moves the ingested pointer.
- [mcp-client.md](mcp-client.md): on re-resolve of upstream metadata changes,
  treat the change as remove+add of that ARK in the next delta.
- [agent-streaming.md](agent-streaming.md): the `ingest.submit` agent tool
  emits an `ingest_event` SSE so the chat shows "Ingestion lancée" and a CTA
  to open Ingérer. `ingest.status` is exposed but rarely used by the agent —
  the user watches the dedicated page.
- [ui-states.md](ui-states.md): the four-stage pipeline is its own visual
  model, not the generic loading/empty/error pattern.
