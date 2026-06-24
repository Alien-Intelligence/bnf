# Corpus Versioning Rule

## Rule

The corpus is **versioned**. Every meaningful edit advances toward a new
`corpus_version`, which is an **immutable membership snapshot**. Ingestion
operates on the **delta** between the last-ingested version and the current
head. Two pointers on the project track this:

- `project.head_version_id` — the current, possibly un-ingested corpus.
- `project.ingested_version_id` — the last version successfully written to the
  index (nullable; null = never ingested).

This is a hard requirement from the client. The whole point of versioning is
to keep iterative corpus growth **cheap**: a re-ingest after adding 400 docs
processes those 400, not the prior 1,700. See
[doc 07](../design/docs/07-ingestion-jobs-and-corpus-delta.md).

## Invariants

These must hold at all times:

1. **A project always has a head.** If a project has no corpus, head is a
   sealed empty version (`seq=1`, `total=0`). This avoids null checks everywhere.
2. **Versions are monotonic per project.** `corpus_version.seq` is a per-project
   integer, advancing by 1.
3. **Membership is immutable per version.** Once a version has any
   `corpus_membership` rows, those rows are never updated or deleted. New
   versions are created instead.
4. **`ingested_version_id` only moves forward, and is the "Dernière ingestion"
   label — NOT the delta source.** A successful **or partial** ingest advances
   it to `target_version_id` and marks that version `status = "ingested"`; only a
   whole-job failure leaves it. The ingestion delta is computed **per document**
   from `Document.indexed_at` (set/cleared by `commit()` /
   `commitPartialFailure()`), so a partial run advances the pointer while the
   docs that failed stay in the delta (`indexed_at = null` + `index_error`). See
   `CorpusQueries.indexedArks()`.
5. **`head_version_id` is always sealed or draft.** Never points at an
   ingested version directly (the head can later become ingested, but the
   pointer is reassigned by the ingest commit, not by a status flip).
6. **One open mutation at a time per project.** A corpus mutation that hasn't
   sealed its new version blocks other mutations on the same project, so seqs
   stay monotonic. 🔶 Recommended via a per-project advisory lock.

## Schema (Prisma)

See [models.md](models.md) for the full convention. The relevant tables:

```prisma
// prisma/schema.prisma
model Project {
  id                String  @id @default(uuid())
  ownerId           String
  name              String
  subtitle          String?
  isPublic          Boolean @default(false)
  headVersionId     String? @unique
  ingestedVersionId String?

  versions  CorpusVersion[]
  documents Document[]
  // …
}

model CorpusVersion {
  id        String   @id @default(uuid())
  projectId String
  seq       Int
  status    String   // CORPUS_VERSION_STATUS
  parentId  String?
  createdBy String   // "agent:session:<sid>" | "user:<uid>"
  note      String?
  createdAt DateTime @default(now())

  project    Project             @relation(fields: [projectId], references: [id])
  parent     CorpusVersion?      @relation("VersionParent", fields: [parentId], references: [id])
  children   CorpusVersion[]     @relation("VersionParent")
  membership CorpusMembership[]
  ingestJobs IngestJob[]

  @@unique([projectId, seq])
}

model CorpusMembership {
  versionId String
  ark       String
  projectId String   // denormalized for filter perf
  version   CorpusVersion @relation(fields: [versionId], references: [id])
  document  Document      @relation(fields: [projectId, ark], references: [projectId, ark])
  @@id([versionId, ark])
}
```

The `headVersionId` is `@unique` so a project can be looked up by its head in
one index lookup.

## Mutations always advance the head

Every corpus mutation (`corpus.add`, `corpus.remove`, the user-driven bulk
remove) goes through `advanceVersion()` in `models/corpus/versioning.ts`. This
is the **only** place that creates new `CorpusVersion` rows.

```ts
// models/corpus/versioning.ts
export async function advanceVersion(
  tx: PrismaTransaction,
  projectId: string,
  parent: CorpusVersionWithArks,
  delta: {
    addArks: string[]
    removeArks: string[]
    createdBy: string
    note?: string
  },
): Promise<CorpusVersion> {
  if (delta.addArks.length === 0 && delta.removeArks.length === 0) {
    // No-op: do not create a new version.
    return parent
  }

  const removed = new Set(delta.removeArks)
  const carried = (await tx.corpusMembership.findMany({
    where: { versionId: parent.id },
    select: { ark: true },
  })).map(r => r.ark).filter(a => !removed.has(a))

  const next = await tx.corpusVersion.create({
    data: {
      projectId,
      seq: parent.seq + 1,
      status: CORPUS_VERSION_STATUS.SEALED,
      parentId: parent.id,
      createdBy: delta.createdBy,
      note: delta.note,
    },
  })

  const members = [...carried, ...delta.addArks].map(ark => ({
    versionId: next.id, ark, projectId,
  }))
  await tx.corpusMembership.createMany({ data: members })

  // Atomically swing the head pointer.
  await tx.project.update({
    where: { id: projectId },
    data: { headVersionId: next.id },
  })

  return next
}
```

Rules:
- `advanceVersion` runs inside a `prisma.$transaction` started by the service
  (the service may also write `Document` rows in the same tx, see below).
- A no-op delta does not create a version. This keeps the version stream
  meaningful (one entry per actual change) and satisfies the "iterate without
  noise" UX.
- `createdBy` is required and uses a stable format: `agent:session:<sid>` for
  agent-initiated mutations, `user:<uid>` for direct user actions.

## `Document` rows live forever; membership decides visibility

Resolving an ARK via the MCP and inserting the row into `Document` is a
**one-time** operation per `(project_id, ark)`. Subsequent versions that
include the same ARK reference the same `Document` row through their
membership. Removing an ARK from the corpus does **not** delete the
`Document` — it just stops being in the new version's membership.

This means:
- A user who re-adds a previously removed ARK gets the existing metadata
  back instantly (no MCP round-trip).
- The MCP/Gallica reference is preserved for audit even after removal.
- 🔶 A `Document` row may be re-resolved (its `raw_metadata` updated) when an
  ingest job runs against a fresh `bnf.resolve` — that is allowed and treated
  as remove+add in the next delta per [doc 07](../design/docs/07-ingestion-jobs-and-corpus-delta.md#edge-cases-to-handle).

## The corpus diff is one query

```ts
// models/corpus/queries.ts
static async diff(
  projectId: string,
  fromSeq: number,
  toSeq: number,
): Promise<CorpusDiff> {
  const [from, to] = await Promise.all([
    prisma.corpusVersion.findFirstOrThrow({ where: { projectId, seq: fromSeq } }),
    prisma.corpusVersion.findFirstOrThrow({ where: { projectId, seq: toSeq } }),
  ])
  const [fromArks, toArks] = await Promise.all([
    this.membershipArks(from.id),
    this.membershipArks(to.id),
  ])
  const fromSet = new Set(fromArks)
  const toSet = new Set(toArks)
  return {
    fromSeq, toSeq,
    added:   toArks.filter(a => !fromSet.has(a)),
    removed: fromArks.filter(a => !toSet.has(a)),
    addedCount:   toArks.filter(a => !fromSet.has(a)).length,
    removedCount: fromArks.filter(a => !toSet.has(a)).length,
  }
}
```

For projects with very large corpora (tens of thousands of ARKs), this is
still cheap — string sets in JS handle 100k items in a few ms. If we ever
need to push it to SQL, the same logic translates to two `EXCEPT` queries.

## The ingest pointer is moved only by `IngestService.commit()`

```ts
// models/ingest/service.ts (excerpt)
static async commit(job: IngestJob, results: IngestResults): Promise<void> {
  await prisma.$transaction([
    prisma.corpusVersion.update({
      where: { id: job.targetVersionId },
      data: { status: CORPUS_VERSION_STATUS.INGESTED },
    }),
    prisma.project.update({
      where: { id: job.projectId },
      data: { ingestedVersionId: job.targetVersionId },
    }),
    prisma.ingestJob.update({
      where: { id: job.id },
      data: { status: INGEST_STATUS.DONE, finishedAt: new Date(),
              chunksWritten: results.chunksWritten,
              stats: results.stats as Prisma.JsonObject },
    }),
  ])
}
```

No other code path writes `project.ingestedVersionId`. If a job fails, the
pointer stays where it was — the next ingest's `base_version` is the same
as the failed one, so retries are idempotent.

## Facets are computed over `head` membership

The corpus comprehension panel (counts by type/lang/source/period) reflects
the **current head**, not the union of all documents ever added to the
project. The histogram and facet chart drive off the same snapshot returned
by `CorpusQueries.snapshot(projectId, "head")`.

For research-time filtering (Step 3, when the agent calls `rag.query` with
filters like `{ type: ["press"] }`), the filter applies to the **ingested**
version's chunks in the cluster — see [ingestion-jobs.md](ingestion-jobs.md).

## Concurrency

Two agent sessions on the same project could each try to add documents in
parallel. The invariant "seqs are monotonic" requires serialization.

🔶 Recommended: a per-project Postgres advisory lock taken at the start of
`CorpusService.addArks` / `removeArks`:

```ts
await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`
```

Held for the duration of the transaction, released on commit/rollback. Two
parallel mutations on the same project queue rather than producing
out-of-order seqs.

## Sample is sampled — never trust `total = sample.length`

`CorpusSnapshot.sample` is a bounded list (~25 documents). `total` is the
full membership count. The UI must always display `total`, never
`sample.length`. The empty state branches on `total === 0`, not
`sample.length === 0`.

```tsx
// ✅
if (corpus.total === 0) return <CorpusEmpty />

// ❌
if (corpus.sample.length === 0) return <CorpusEmpty />   // false-positive when total > 0
```

## Forbidden patterns

```ts
// ❌ Mutating membership of an existing version
await prisma.corpusMembership.create({ data: { versionId: existing.id, ark } })
// → versions are immutable; create a new version via advanceVersion()

// ❌ Two corpus mutations without going through advanceVersion()
await prisma.document.create(...)
await prisma.project.update({ where: { id }, data: { headVersionId: ... } })
// → headVersionId must only be moved by advanceVersion()

// ❌ Updating ingestedVersionId outside IngestService.commit()
await prisma.project.update({ data: { ingestedVersionId: someVersionId } })

// ❌ Computing the diff client-side
const added = newSample.filter(d => !old.find(o => o.ark === d.ark))
// → sample is sampled; use the API CorpusQueries.diff()

// ❌ Treating sample.length as total
{corpus.sample.length} documents
// Use: {corpus.total}
```

## Relation to other rules

- [ingestion-jobs.md](ingestion-jobs.md) consumes the diff to plan extract/
  chunk/embed/index stages.
- [agent-streaming.md](agent-streaming.md) emits `corpus_event` SSE events
  carrying `{ kind: "add"|"remove", count, version }` so the UI updates as
  `advanceVersion()` returns.
- [models.md](models.md): the versioning code lives in
  `models/corpus/versioning.ts`. It is owned by the corpus model; the ingest
  service consumes it but does not extend it.
