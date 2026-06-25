import "server-only"
// models/ingest/service.ts
// Business logic for the ingestion lifecycle.
//
// INVARIANTS (enforced here, never elsewhere):
//   • project.ingestedVersionId is moved ONLY within this service — by
//     IngestService.commit() (full success) AND commitPartialFailure() (partial
//     run). The per-doc Document.indexedAt is the real delta truth; this pointer
//     is the "Dernière ingestion vN" label. Only a WHOLE-job failure leaves it
//     behind.
//   • The no-op short-circuit (added=[] && removed=[]) creates a done job and
//     advances bookkeeping in a single atomic transaction without calling the cluster.
//   • Deduplication: if a (projectId, targetVersionId) job is already queued/running,
//     IngestService.submit() returns the existing job — no new row.
import crypto from "node:crypto"
import { prisma } from "@/lib/db"
import { Prisma } from "@/lib/generated/prisma/client"
import type { IngestJob, Project, User } from "@/lib/generated/prisma/client"
import { CorpusQueries } from "@/models/corpus/queries"
import {
  classifyIngestion,
  DOCUMENT_RESOLVE_STATUS,
  INGESTION_CLASS,
  isIngestableClass,
} from "@/models/documents/schema"
import { estimatePaidOcrCostUsd, INGEST_STATUS } from "./schema"
import type { PaidOcrEstimate } from "./schema"
import type {
  IngestResults,
  IngestSubmitInput,
  IngestSubmitOutcome,
} from "./types"
import type { ClusterProgressEvent } from "@/lib/cluster/contracts"
import { ClusterRunner } from "@/lib/cluster/runner"
import { PAID_OCR_DEFAULT_BUDGET_USD } from "@/lib/constants"
import { env } from "@/lib/env"

export class IngestService {
  /**
   * Submit an ingestion job for a project.
   *
   * Resolution order:
   *   1. Resolve target version (head, or the explicitly requested seq).
   *   2. Resolve base version (last ingested, or null for first ingest).
   *   3. Compute the delta: added = target ∖ base, removed = base ∖ target.
   *   4. Deduplication: if a queued/running job already exists for
   *      (projectId, targetVersionId), return it unchanged.
   *   4b. Paid-OCR gate (only when project.paidOcrEnabled): if the delta carries
   *      `sans_texte` docs, require `input.confirmPaidOcr` and a budget headroom
   *      check before folding them into the job. Returns a non-`job` outcome
   *      otherwise.
   *   5. No-op short-circuit: if delta is empty, create a done job + advance
   *      ingestedVersionId atomically. No cluster call.
   *   6. Insert job row, enqueue to cluster runner.
   */
  static async submit(
    project: Project,
    user: User,
    input: IngestSubmitInput,
  ): Promise<IngestSubmitOutcome> {
    // 1. Resolve target version
    let targetVersion: Awaited<ReturnType<typeof CorpusQueries.headVersion>>

    if (input.targetVersionSeq !== undefined) {
      targetVersion = await prisma.corpusVersion.findUniqueOrThrow({
        where: {
          projectId_seq: {
            projectId: project.id,
            seq: input.targetVersionSeq,
          },
        },
        include: { membership: { select: { ark: true } } },
      })
    } else {
      targetVersion = await CorpusQueries.headVersion(project.id)
    }

    // 2. Resolve base version — kept for the job's baseVersionId provenance and
    // the "Dernière ingestion vN" label. The DELTA itself is computed per-doc
    // (below) against the indexed set, not this pointer, so a partial ingest's
    // successes drop out of the next delta.
    const baseVersion = await CorpusQueries.ingestedVersion(project.id)

    // 3. Compute delta — per DOCUMENT, against what's actually in the index
    // (Document.indexedAt), NOT version-membership against the pointer. This is
    // what lets a partial ingest leave only the failed doc in the delta.
    const targetArks = await CorpusQueries.membershipArks(targetVersion.id)
    const indexedArks = await CorpusQueries.indexedArks(project.id)

    const indexedSet = new Set(indexedArks)
    const targetSet = new Set(targetArks)

    const deltaAddedArks = targetArks.filter((a) => !indexedSet.has(a))
    const removedArks = indexedArks.filter((a) => !targetSet.has(a))

    // 3b. Drop non-ingestable docs from the added delta. Catalogue notices
    // (cb*), non-digitized records, and digitized-but-text-less docs have no
    // OCR and no image to describe — sending them to the worker only produces
    // retry-loops on ARKs that can never succeed. They are already flagged
    // non-ingestable in the corpus view; honor that here. The excluded set is
    // recorded on the job for an honest count (the worker never sees them).
    //
    // When paid OCR is enabled for the project, `sans_texte` docs are NOT
    // excluded — they split into a third `paidOcr` bucket handled at step 4b.
    const {
      ingestable,
      excluded: excludedArks,
      paidOcr: paidOcrArks,
    } = await IngestService._partitionByIngestability(project.id, deltaAddedArks, {
      paidOcr: project.paidOcrEnabled,
    })

    // 4. Deduplication guard. Runs BEFORE the paid-OCR gate so re-submitting
    // while a job is already in flight reuses it without re-prompting for spend.
    const existing = await prisma.ingestJob.findFirst({
      where: {
        projectId: project.id,
        targetVersionId: targetVersion.id,
        status: { in: [INGEST_STATUS.QUEUED, INGEST_STATUS.RUNNING] },
      },
    })
    if (existing) return { kind: "job", job: existing }

    // 4b. Paid-OCR gate. If the delta carries `sans_texte` docs, the user must
    // authorize the spend (per-ingestion confirmation) and the project must have
    // budget headroom. Only on success are these ARKs folded into the job.
    let paidOcrEstimatedUsd: number | null = null
    if (paidOcrArks.length > 0) {
      const estimate = await IngestService._estimatePaidOcr(project.id, paidOcrArks)
      if (!input.confirmPaidOcr) {
        return { kind: "confirmation_required", paidOcr: estimate }
      }
      const ceilingUsd =
        project.paidOcrBudgetUsd === null
          ? PAID_OCR_DEFAULT_BUDGET_USD
          : Number(project.paidOcrBudgetUsd)
      const spentUsd = Number(project.paidOcrSpentUsd)
      if (spentUsd + estimate.usd > ceilingUsd) {
        return { kind: "budget_exceeded", paidOcr: estimate, spentUsd, ceilingUsd }
      }
      paidOcrEstimatedUsd = estimate.usd
    }

    // Confirmed paid-OCR docs join the added delta; the worker transcribes them.
    const addedArks = [...ingestable, ...paidOcrArks]

    // 5. No-op short-circuit. Nothing ingestable to add and nothing to remove
    // means the index content for the target version already matches what's
    // there — advance the pointer without a cluster round-trip. Excluded docs
    // don't change index content, so an all-excluded added delta is a no-op.
    if (addedArks.length === 0 && removedArks.length === 0) {
      return {
        kind: "job",
        job: await IngestService._commitNoOp(
          project,
          user,
          targetVersion.id,
          baseVersion?.id ?? null,
          excludedArks,
        ),
      }
    }

    // 6. Fetch document metadata for the cluster
    const addedDocs = await IngestService._loadClusterDocs(project.id, addedArks)

    // 7. Generate a per-job HMAC secret
    const callbackSecret = crypto.randomBytes(32).toString("hex")

    // 8. Insert job row
    const job = await prisma.ingestJob.create({
      data: {
        projectId: project.id,
        targetVersionId: targetVersion.id,
        baseVersionId: baseVersion?.id ?? null,
        status: INGEST_STATUS.QUEUED,
        addedCount: addedArks.length,
        removedCount: removedArks.length,
        addedArks,
        removedArks,
        excludedArks,
        excludedCount: excludedArks.length,
        paidOcrArks,
        paidOcrEstimatedUsd,
        callbackSecret,
      },
    })

    // 9. Enqueue to cluster runner (fire-and-forget; route handles progress via callback)
    // WORKER_CALLBACK_BASE_URL lets us override the host the cluster runner
    // calls back on. In docker-compose dev the worker can't resolve
    // `localhost:3001` (that's the container itself); set this to
    // `http://host.docker.internal:3001`. In prod the worker reaches the
    // public APP_URL so leave it unset.
    const callbackBase = process.env.WORKER_CALLBACK_BASE_URL ?? env.APP_URL
    const callbackUrl = `${callbackBase}/api/internal/ingest/${job.id}/progress`

    const { clusterJobId } = await ClusterRunner.submit({
      projectId: project.id,
      targetVersionId: targetVersion.id,
      appJobId: job.id,
      added: addedDocs,
      removed: removedArks,
      callbackUrl,
      callbackSecret,
    })

    // 10. Persist clusterJobId and transition to running
    const running = await prisma.ingestJob.update({
      where: { id: job.id },
      data: {
        clusterJobId,
        status: INGEST_STATUS.RUNNING,
        startedAt: new Date(),
      },
    })
    return { kind: "job", job: running }
  }

  /**
   * Compute the delta that the next ingestion would carry — WITHOUT creating a
   * job. Used to render the Ingérer overview (head vs. ingested versions and
   * the +added / -removed counts).
   *
   * This mirrors {@link submit} steps 1–3b exactly so the preview can never
   * drift from what an actual submit produces:
   *   • target  = head version
   *   • base    = last ingested version (null on first ingest)
   *   • added   = (target ∖ base), then minus non-ingestable docs
   *   • removed = base ∖ target
   *   • excluded = non-ingestable docs dropped from the added delta
   *
   * `added` counts only ingestable docs because those are the only ones a
   * submit would actually send — surfacing the raw corpus size here is the bug
   * this method replaces (it showed the whole head corpus as "to ingest" even
   * when most of it was already ingested).
   */
  static async previewDelta(
    project: Project,
  ): Promise<{
    added: number
    removed: number
    excluded: number
    paidOcr: PaidOcrEstimate
  }> {
    const targetVersion = await CorpusQueries.headVersion(project.id)

    // Per-doc delta against the index (same source as submit()), so the preview
    // can never drift from an actual submit. added = head docs not indexed;
    // removed = indexed docs gone from head.
    const targetArks = await CorpusQueries.membershipArks(targetVersion.id)
    const indexedArks = await CorpusQueries.indexedArks(project.id)

    const indexedSet = new Set(indexedArks)
    const targetSet = new Set(targetArks)

    const deltaAddedArks = targetArks.filter((a) => !indexedSet.has(a))
    const removedArks = indexedArks.filter((a) => !targetSet.has(a))

    // Same partition (and same paidOcr gate) as submit(), so the preview's
    // counts and cost estimate can never drift from what a submit would carry.
    const { ingestable, excluded, paidOcr } =
      await IngestService._partitionByIngestability(project.id, deltaAddedArks, {
        paidOcr: project.paidOcrEnabled,
      })

    return {
      added: ingestable.length,
      removed: removedArks.length,
      excluded: excluded.length,
      paidOcr: await IngestService._estimatePaidOcr(project.id, paidOcr),
    }
  }

  /**
   * Cancel an in-flight job.
   * Sets status to "canceled" and tells the cluster runner to abort.
   * Best-effort: partial vectors written by the cluster may remain in the index.
   * `_user` is the authenticated user — kept for future audit logging.
   */
  static async cancel(job: IngestJob, _user: User): Promise<IngestJob> {
    const updated = await prisma.ingestJob.update({
      where: { id: job.id },
      data: { status: INGEST_STATUS.CANCELED, finishedAt: new Date() },
    })
    if (job.clusterJobId) {
      await ClusterRunner.cancel(job.clusterJobId)
    }
    return updated
  }

  /**
   * Apply a progress event posted by the cluster to the job row.
   *
   * - Running stages: update status, stage, progress, stats.
   * - done: delegate to commit().
   * - failed: record error, mark failed. ingestedVersionId NOT advanced.
   *
   * NOTE: IngestPubSub is not yet wired (slice 4b). This method only does DB
   * writes. SSE stream integration lands in a later commit.
   */
  static async applyProgress(
    job: IngestJob,
    event: ClusterProgressEvent,
  ): Promise<void> {
    if (event.stage === "done") {
      // The job reached "done": commit (all succeeded) or commitPartialFailure
      // (some failed). BOTH advance the baseline pointer — the per-doc
      // Document.indexedAt carries which docs actually made it, so a partial run
      // can move the pointer without orphaning the failures (they stay in the
      // delta via indexedAt=null + indexError). Only the 'failed' stage below
      // (the whole job died) leaves the pointer untouched.
      const failedCount = Number(
        (event.stats as Record<string, unknown>)?.failed ?? 0,
      )
      if (failedCount > 0) {
        await IngestService.commitPartialFailure(job, {
          chunksWritten: event.chunksWritten,
          stats: event.stats,
        })
      } else {
        await IngestService.commit(job, {
          chunksWritten: event.chunksWritten,
          stats: event.stats,
        })
      }
    } else if (event.stage === "failed") {
      await prisma.ingestJob.update({
        where: { id: job.id },
        data: {
          status: INGEST_STATUS.FAILED,
          error: event.error,
          finishedAt: new Date(),
          ...(event.partialStats
            ? { stats: event.partialStats as never }
            : {}),
        },
      })
    } else {
      // Running stage: extract | chunk | embed | index
      await prisma.ingestJob.update({
        where: { id: job.id },
        data: {
          status: INGEST_STATUS.RUNNING,
          stage: event.stage,
          progress: event.fraction,
          stats: event.counters as never,
        },
      })
    }
  }

  /**
   * Commit a successful ingest.
   *
   * Atomically:
   *   • Mark job done with chunksWritten + stats.
   *   • Mark targetVersion status = "ingested".
   *   • Advance project.ingestedVersionId.
   *   • Stamp Document.indexedAt for every added ARK; clear it for removed ARKs.
   *
   * The pointer is also advanced by commitPartialFailure() (a partial run still
   * moves the baseline); only a whole-job failure leaves it. See
   * playbook/corpus-versioning.md invariant 4 and ingestion-jobs.md.
   */
  static async commit(job: IngestJob, results: IngestResults): Promise<void> {
    const now = new Date()
    await prisma.$transaction([
      prisma.ingestJob.update({
        where: { id: job.id },
        data: {
          status: INGEST_STATUS.DONE,
          finishedAt: now,
          chunksWritten: results.chunksWritten,
          stats: results.stats as never,
        },
      }),
      prisma.corpusVersion.update({
        where: { id: job.targetVersionId },
        data: { status: "ingested" },
      }),
      prisma.project.update({
        where: { id: job.projectId },
        data: { ingestedVersionId: job.targetVersionId },
      }),
      // Per-doc index state: every added ARK is now in the index; every removed
      // ARK is out. Keeps the delta truthful independent of the version pointer.
      prisma.document.updateMany({
        where: { projectId: job.projectId, ark: { in: job.addedArks } },
        data: { indexedAt: now, indexError: null },
      }),
      prisma.document.updateMany({
        where: { projectId: job.projectId, ark: { in: job.removedArks } },
        data: { indexedAt: null },
      }),
    ])
  }

  /**
   * Terminal state for a job that finished but had per-doc failures (PARTIAL).
   *
   * Stamps Document.indexedAt for the ARKs that DID succeed (added ∖ failed), so
   * they drop out of the next delta, and records each failed ARK's reason in
   * Document.indexError (indexedAt left null → it stays in the delta as the one
   * to retry). Persists `stats.errors[]` for retryFailed. Status is PARTIAL, not
   * FAILED, so the UI reads it as "N indexed / M failed", not a blanket "Échec".
   *
   * ADVANCES project.ingestedVersionId to the target (and marks the version
   * "ingested"), same as commit(): a partial run still moved the baseline
   * forward — the per-doc delta (Document.indexedAt) carries the truth of which
   * docs remain, so the pointer is just the "Dernière ingestion vN" label. ONLY
   * a whole-job failure (applyProgress 'failed' stage) leaves the pointer where
   * it was. See corpus-versioning.md invariant 4.
   */
  static async commitPartialFailure(
    job: IngestJob,
    results: IngestResults,
  ): Promise<void> {
    const stats = results.stats as Record<string, unknown>
    const failed = Number(stats?.failed ?? 0)
    const total = Number(stats?.total ?? 0)
    const errorByArk = IngestService._errorsByArk(stats)
    const failedSet = new Set(errorByArk.keys())
    const succeededAdded = job.addedArks.filter((a) => !failedSet.has(a))
    const now = new Date()

    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.ingestJob.update({
        where: { id: job.id },
        data: {
          status: INGEST_STATUS.PARTIAL,
          finishedAt: now,
          chunksWritten: results.chunksWritten,
          stats: results.stats as never,
          error: `${failed}/${total} document(s) en échec — réessayez les documents échoués`,
        },
      }),
      // A partial run still advances the baseline (same as commit) — the per-doc
      // Document.indexedAt above is the real delta truth; this pointer is just the
      // "Dernière ingestion vN" label. Only a whole-job failure leaves it behind.
      prisma.corpusVersion.update({
        where: { id: job.targetVersionId },
        data: { status: "ingested" },
      }),
      prisma.project.update({
        where: { id: job.projectId },
        data: { ingestedVersionId: job.targetVersionId },
      }),
    ]
    if (succeededAdded.length > 0) {
      ops.push(
        prisma.document.updateMany({
          where: { projectId: job.projectId, ark: { in: succeededAdded } },
          data: { indexedAt: now, indexError: null },
        }),
      )
    }
    // Mark each failed doc with its reason; indexedAt stays null so it remains
    // the outstanding delta. updateMany (not update) so a missing row can't throw.
    for (const [ark, reason] of errorByArk) {
      ops.push(
        prisma.document.updateMany({
          where: { projectId: job.projectId, ark },
          data: { indexError: reason },
        }),
      )
    }
    if (job.removedArks.length > 0) {
      ops.push(
        prisma.document.updateMany({
          where: { projectId: job.projectId, ark: { in: job.removedArks } },
          data: { indexedAt: null },
        }),
      )
    }
    await prisma.$transaction(ops)
  }

  /** Map of failed ARK → reason, read from the worker's `stats.errors[]`. */
  private static _errorsByArk(
    stats: Record<string, unknown> | null | undefined,
  ): Map<string, string> {
    const raw = stats?.errors
    const out = new Map<string, string>()
    if (!Array.isArray(raw)) return out
    for (const e of raw) {
      if (e && typeof e === "object" && typeof (e as { ark?: unknown }).ark === "string") {
        const r = e as { ark: string; stage?: unknown; reason?: unknown }
        out.set(
          r.ark,
          typeof r.reason === "string"
            ? r.reason
            : typeof r.stage === "string"
              ? r.stage
              : "échec",
        )
      }
    }
    return out
  }

  /**
   * Retry failed documents from a previous ingest job.
   *
   * Reads `stats.errors` from the source job for the list of failed ARKs.
   * If there are no recorded per-document errors, returns `{ created: false }`.
   * Otherwise creates a new ingest job targeting the same version with
   * `addedArks = failed ARKs` and `removedArks = []`.
   *
   * The source job may be in any state — the deduplication guard in submit()
   * does not apply here because we target a known ARK subset, not the full delta.
   */
  static async retryFailed(
    jobId: string,
    _user: User,
  ): Promise<{ created: false } | IngestJob> {
    const job = await prisma.ingestJob.findUniqueOrThrow({ where: { id: jobId } })

    // Defensively read stats.errors — absent when no per-doc failures were
    // recorded (e.g. FakeClusterRunner stub, or job died before emit).
    const stats = job.stats as Record<string, unknown> | null | undefined
    const rawErrors = stats?.errors
    const errors = Array.isArray(rawErrors)
      ? (rawErrors as { ark: string; stage: string; reason: string }[])
      : []

    if (errors.length === 0) return { created: false }

    const failedArks = errors.map((e) => e.ark)

    const addedDocs = await IngestService._loadClusterDocs(job.projectId, failedArks)

    const callbackSecret = crypto.randomBytes(32).toString("hex")

    const retryJob = await prisma.ingestJob.create({
      data: {
        projectId: job.projectId,
        targetVersionId: job.targetVersionId,
        baseVersionId: job.baseVersionId,
        status: INGEST_STATUS.QUEUED,
        addedCount: failedArks.length,
        removedCount: 0,
        addedArks: failedArks,
        removedArks: [],
        callbackSecret,
      },
    })

    const retryCallbackBase = process.env.WORKER_CALLBACK_BASE_URL ?? env.APP_URL
    const callbackUrl = `${retryCallbackBase}/api/internal/ingest/${retryJob.id}/progress`

    const { clusterJobId } = await ClusterRunner.submit({
      projectId: job.projectId,
      targetVersionId: job.targetVersionId,
      appJobId: retryJob.id,
      added: addedDocs,
      removed: [],
      callbackUrl,
      callbackSecret,
    })

    return prisma.ingestJob.update({
      where: { id: retryJob.id },
      data: {
        clusterJobId,
        status: INGEST_STATUS.RUNNING,
        startedAt: new Date(),
      },
    })
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * No-op short-circuit path: added and removed are both empty.
   * Creates a terminal done job and advances ingestedVersionId atomically.
   * Does NOT call the cluster runner.
   */
  private static async _commitNoOp(
    project: Project,
    _user: User,
    targetVersionId: string,
    baseVersionId: string | null,
    excludedArks: string[] = [],
  ): Promise<IngestJob> {
    const now = new Date()
    let job!: IngestJob
    await prisma.$transaction(async (tx) => {
      job = await tx.ingestJob.create({
        data: {
          projectId: project.id,
          targetVersionId,
          baseVersionId,
          status: INGEST_STATUS.DONE,
          addedCount: 0,
          removedCount: 0,
          addedArks: [],
          removedArks: [],
          excludedArks,
          excludedCount: excludedArks.length,
          chunksWritten: 0,
          stats: { noOp: true },
          startedAt: now,
          finishedAt: now,
        },
      })
      await tx.corpusVersion.update({
        where: { id: targetVersionId },
        data: { status: "ingested" },
      })
      await tx.project.update({
        where: { id: project.id },
        data: { ingestedVersionId: targetVersionId },
      })
    })
    return job
  }

  /**
   * Split an added-delta ARK list into the docs worth ingesting and the docs
   * to drop. A doc is dropped only when we are CONFIDENT it is non-ingestable:
   *
   *   • not digitized (no IIIF manifest — catalogue `cb*` notices). This is
   *     deterministic from the ARK at stub time, so it holds even before
   *     metadata resolution.
   *   • OR fully resolved AND classified non-ingestable (digitized but no OCR
   *     and not an image-like type → no text and nothing to vision-describe).
   *
   * A digitized doc whose metadata hasn't resolved yet is NEVER dropped — its
   * classification is still provisional, so we let the worker attempt it (and
   * the worker's fail-fast path skips it cleanly if it turns out to be empty).
   *
   * A corpus member always has a Document row; an ARK with no row is treated as
   * ingestable (the worker resolves it from scratch) rather than silently lost.
   *
   * `opts.paidOcr` opts into the paid fallback OCR (Mistral) path: a CONFIDENT
   * `sans_texte` doc (digitized text, no OCR layer, not an image type) is then
   * routed to a third `paidOcr` bucket instead of being excluded — these become
   * ingestable, but only after the user confirms the spend. With the flag off
   * (the default), `sans_texte` stays excluded exactly as before, so the
   * behaviour of every existing caller is unchanged.
   */
  private static async _partitionByIngestability(
    projectId: string,
    arks: string[],
    opts: { paidOcr?: boolean } = {},
  ): Promise<{ ingestable: string[]; excluded: string[]; paidOcr: string[] }> {
    if (arks.length === 0) return { ingestable: [], excluded: [], paidOcr: [] }
    const rows = await prisma.document.findMany({
      where: { projectId, ark: { in: arks } },
      select: {
        ark: true,
        docType: true,
        ocrAvailable: true,
        iiifManifestUrl: true,
        resolveStatus: true,
      },
    })
    const byArk = new Map(rows.map((r) => [r.ark, r]))

    const ingestable: string[] = []
    const excluded: string[] = []
    const paidOcr: string[] = []
    for (const ark of arks) {
      const doc = byArk.get(ark)
      if (!doc) {
        // No row — let the worker resolve and decide rather than drop blindly.
        ingestable.push(ark)
        continue
      }
      const digitized = Boolean(doc.iiifManifestUrl)
      const cls = classifyIngestion({
        docType: doc.docType,
        ocrAvailable: doc.ocrAvailable,
        digitized,
      })
      const confident =
        !digitized || doc.resolveStatus === DOCUMENT_RESOLVE_STATUS.RESOLVED
      if (opts.paidOcr && confident && cls === INGESTION_CLASS.SANS_TEXTE) {
        // Digitized text with no OCR layer — transcribable via paid Mistral OCR
        // once the spend is confirmed. Intercept before the generic drop below.
        paidOcr.push(ark)
      } else if (!isIngestableClass(cls) && confident) {
        excluded.push(ark)
      } else {
        ingestable.push(ark)
      }
    }
    return { ingestable, excluded, paidOcr }
  }

  /**
   * Estimate the paid-OCR cost for a set of `sans_texte` ARKs from their stored
   * page counts (`Document.pages`). A missing row or null page count falls back
   * to the conservative default inside estimatePaidOcrCostUsd(). The worker
   * reports the real billed cost on completion.
   */
  private static async _estimatePaidOcr(
    projectId: string,
    arks: string[],
  ): Promise<PaidOcrEstimate> {
    if (arks.length === 0) return { docCount: 0, pages: 0, usd: 0 }
    const rows = await prisma.document.findMany({
      where: { projectId, ark: { in: arks } },
      select: { ark: true, pages: true },
    })
    const pagesByArk = new Map(rows.map((r) => [r.ark, r.pages]))
    return estimatePaidOcrCostUsd(arks.map((ark) => pagesByArk.get(ark) ?? null))
  }

  /**
   * Load Document rows for the given ARKs and map them to ClusterDoc shape.
   * `source` is required by the cluster but nullable in the DB — we fall back
   * to "unknown" only as a last resort (all real BnF documents have a source).
   */
  private static async _loadClusterDocs(
    projectId: string,
    arks: string[],
  ): Promise<
    {
      ark: string
      title: string
      year: number | null
      docType: string
      subtype: string | null
      lang: string | null
      source: string
      iiifManifestUrl: string | null
    }[]
  > {
    if (arks.length === 0) return []
    const rows = await prisma.document.findMany({
      where: { projectId, ark: { in: arks } },
      select: {
        ark: true,
        title: true,
        year: true,
        docType: true,
        subtype: true,
        lang: true,
        source: true,
        iiifManifestUrl: true,
      },
    })
    return rows.map((doc) => ({
      ark: doc.ark,
      // title/docType are null on stubs whose metadata hasn't resolved yet. The
      // cluster contract requires strings; fall back rather than crash. Such a
      // doc has no full text anyway and the cluster will record it as a per-doc
      // skip (see ingestion-jobs.md — one bad doc never fails the whole job).
      title: doc.title ?? doc.ark,
      year: doc.year,
      docType: doc.docType ?? "other",
      subtype: doc.subtype,
      lang: doc.lang,
      source: doc.source ?? "unknown",
      iiifManifestUrl: doc.iiifManifestUrl,
    }))
  }
}

