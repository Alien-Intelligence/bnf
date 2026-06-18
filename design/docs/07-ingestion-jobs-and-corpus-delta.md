# 07 — Ingestion Jobs & Corpus Delta

This is the most infrastructure-heavy part and encodes the client's explicit
requirements:

> - "We have the data clusters **ready**."
> - "We will need some **custom scripts** that ingest, chunk and embed documents,
>   **faster than our normal pipelines**."
> - "The backend of this app **must be able to run jobs** somehow."
> - "We need a way to **delta the state of the corpus before/after** (same as a
>   job) so we can **iteratively add** more documents."

> Status: ✅ requirement/contract · 🔶 proposed default · ⛔ owned by the cluster team.

## The shape of the requirement

Ingestion is **asynchronous, long-running, and incremental**:

- **Asynchronous** — the UI says "the processing continues server-side, come back
  later" (the prototype shows an est. of hours). The user is not blocked.
- **Long-running** — thousands of documents × OCR + chunk + embed + index.
- **Incremental** — re-ingesting after adding 400 documents to a 1,700-document
  corpus must process **only the ~400 new ones**, not all 2,100.

So the backend needs a **job runner** (queue + workers + progress + retries), and
the corpus needs **versioning + delta** so each job has a well-defined input set.

## Corpus versioning recap (from doc 03)

- Every corpus edit advances toward a new **`corpus_version`** (immutable
  membership snapshot).
- `project.head_version_id` = current (maybe un-ingested) corpus.
- `project.ingested_version_id` = last version successfully written to the index.
- `corpus.diff(base, target)` = `{ added: ARK[], removed: ARK[] }`.

## What an ingest job does

```
ingest_job(target_version, base_version = project.ingested_version_id)
  │
  1. PLAN
  │    delta = corpus.diff(base, target)
  │    added   = delta.added      (need OCR → chunk → embed → index)
  │    removed = delta.removed    (need tombstone/delete from index)
  │    if base == null: added = full membership(target)   (first ingest)
  │
  2. EXTRACT   (per added doc)        stage="extract"
  │    fetch OCR/ALTO text (Gallica) or run fallback OCR ⛔
  │    normalize text; store to object storage; cache excerpt
  │
  3. CHUNK     (per added doc)        stage="chunk"
  │    semantic chunking (~512 tokens, overlap) — the CUSTOM fast script ⛔
  │    each chunk carries metadata: { ark, folio, char_range, title, year, type }
  │
  4. EMBED     (batched)              stage="embed"
  │    embed chunks with the cluster's embedding model (fixed) ⛔
  │
  5. INDEX                            stage="index"
  │    upsert vectors+metadata into the project's index in the data cluster ⛔
  │    delete vectors for `removed` ARKs (tombstone)
  │
  6. COMMIT
       project.ingested_version_id = target_version
       corpus_version.status = 'ingested'
       job.status = 'done'
```

The **custom fast scripts** the client mentioned are steps 3–5 (chunk/embed/
index). They are ⛔ owned by the building/cluster team; this app's job runner
**invokes and monitors** them and persists progress. The contract this app needs
from those scripts:

```
run_ingest(project_id, index, added_docs[], removed_arks[], progress_cb) -> { chunks_written, … }
  added_docs[i] = { ark, text|text_ref, folio_map, metadata }
  progress_cb(stage, fraction, counters)   # so the job runner can update ingest_job.progress
```

## Job runner requirements ✅

- **Queue + workers** — durable queue; workers pull jobs; concurrency per project
  bounded 🔶.
- **Progress reporting** — per-stage (`extract|chunk|embed|index`) fraction +
  counters (docs done, chunks written), surfaced to the UI exactly like the
  prototype's 4-stage pipeline view. Pub/sub (Redis) or DB-poll 🔶.
- **Resumability / idempotency** — a job that dies mid-`embed` resumes without
  re-embedding completed chunks; re-running a job for the same `target_version`
  is a no-op if already ingested. Key on `(project, target_version)` +
  per-chunk content hashes 🔶.
- **Partial failure** — one bad document (OCR fails) shouldn't fail the whole
  job; record per-doc errors in `ingest_job.stats`, continue, report at the end.
- **Cancellation** — a job can be canceled; partial index writes are either
  tombstoned or left for the next delta to reconcile 🔶.
- **One active ingest per project** 🔶 — serialize ingests per project so
  `ingested_version_id` advances monotonically and deltas stay well-defined.

⛔ The runner technology (e.g. a queue + worker framework, a workflow engine, or
the cluster's own batch system) is the building team's choice. The **contract**
above (stages, progress, delta input, idempotency) is what matters.

## The delta is the whole point

Because each job ingests `corpus.diff(ingested_version, head_version)`:

- **Iterative corpus growth is cheap.** Add 400 docs in Step 1 → re-ingest →
  only those 400 are OCR'd/chunked/embedded; the prior 1,700 are untouched.
- **Removals are handled.** Documents removed from the corpus are **tombstoned**
  (vectors deleted) so research never retrieves dropped sources.
- **Versions are auditable.** You can always answer "what changed between the
  last two ingests" (`corpus.diff`) — useful for the UI's "+N / −N" events and
  for debugging retrieval.

### Edge cases to handle 🔶
- A document's metadata changes upstream (re-resolution) → treat as remove+add of
  that ARK in the next delta.
- Re-ingest with **no delta** → no-op job that just advances bookkeeping.
- Changing the **embedding model** → not a delta; it's a **full re-ingest** of the
  project (every chunk must be re-embedded against the new model). Guard against
  accidental model drift (doc 02): the index and the query path must use the
  **same** embedding model.

## UI contract (Step 2) ✅

The ingestion screen needs, from `GET /ingest/:job_id` (poll or SSE):

```json
{ "status": "running",
  "stage": "embed",
  "progress": 0.52,
  "added_count": 474, "removed_count": 208,
  "chunks_written": 18540,
  "eta_seconds": 4200,
  "stages": [
    { "key":"extract", "status":"done",    "fraction":1.0 },
    { "key":"chunk",   "status":"done",    "fraction":1.0 },
    { "key":"embed",   "status":"running", "fraction":0.52 },
    { "key":"index",   "status":"pending", "fraction":0.0 } ] }
```

This maps directly onto the prototype's four pipeline rows, the overall percent,
the "come back later" banner (while `status=running`), and the completion state
(`status=done` → "open research workspace", which targets the now-current
`ingested_version_id`).
