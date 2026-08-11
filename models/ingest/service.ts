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
  isLatinScriptLang,
} from "@/models/documents/schema"
import { estimatePaidOcrCostUsd, INGEST_STATUS } from "./schema"
import type { PaidOcrEstimate } from "./schema"
import type {
  IngestDeltaPreview,
  IngestResults,
  IngestSubmitInput,
  IngestSubmitOutcome,
} from "./types"
import type {
  ClusterProgressEvent,
  ClusterQueueProgress,
} from "@/lib/cluster/contracts"
import { ClusterRunner } from "@/lib/cluster/runner"
import { PAID_OCR_DEFAULT_BUDGET_USD } from "@/lib/constants"
import { env } from "@/lib/env"

/**
 * F20 — the pure selection logic behind {@link IngestService.retryFailed}.
 * Pulled out of the class (no Prisma, no I/O) so the fallback rule is
 * unit-testable without a database: given the source job's `stats.errors`
 * AND the current per-doc `Document` truth, decide which ARKs a retry job
 * should target.
 *
 *   • `statsErrors` non-empty → those ARKs (the normal path: the worker's
 *     terminal callback recorded exactly which docs failed).
 *   • `statsErrors` empty → fall back to `documentRows`, already expected to
 *     be pre-filtered by the caller to `addedArks` members with
 *     `indexedAt === null && indexError !== null` (never indexed, and a
 *     reason is on record). `addedArks` is re-checked here too, so the
 *     function is correct even if a caller passes an unfiltered row set.
 *   • Both empty → `[]` (the caller reports `{ created: false }`).
 */
export function computeRetryArks(
  statsErrors: ReadonlyArray<{ ark: string }>,
  addedArks: readonly string[],
  documentRows: ReadonlyArray<{
    ark: string
    indexedAt: Date | null
    indexError: string | null
  }>,
): string[] {
  if (statsErrors.length > 0) return statsErrors.map((e) => e.ark)
  const addedSet = new Set(addedArks)
  return documentRows
    .filter((d) => addedSet.has(d.ark) && d.indexedAt === null && d.indexError !== null)
    .map((d) => d.ark)
}

/**
 * F13 warning channel (ai-memories/tech/repos/bnf/ingest-hardening) — the pure
 * logic behind {@link IngestService.applyProgress}'s done-routing decision.
 * `stats.errors[]` now carries BOTH real per-doc failures and `warning: true`
 * entries (a doc that succeeded but lost OCR pages). A warning entry must
 * NEVER be counted as a failure: a `done` event whose `errors[]` contains
 * ONLY warnings still routes to `commit()`, not `commitPartialFailure()`.
 * Pulled out of the class (no Prisma, no I/O) for the same reason as
 * {@link computeRetryArks} — unit-testable without a database.
 */
export function countNonWarningErrors(
  errors: ReadonlyArray<{ warning?: unknown }>,
): number {
  return errors.filter((e) => e.warning !== true).length
}

/** One parsed entry from the worker's `stats.errors[]` (F13). */
export interface ParsedErrorEntry {
  reason: string
  warning: boolean
}

/**
 * Pure parse of `stats.errors[]` into `ark → { reason, warning }`. Defensive
 * against a missing/malformed entry (no `ark` string → skipped) the same way
 * the pre-F13 code was. Shared by {@link IngestService.commit} (which only
 * ever sees warning entries) and {@link IngestService.commitPartialFailure}
 * (which sees both).
 */
export function parseErrorEntries(
  errors: ReadonlyArray<{
    ark?: unknown
    stage?: unknown
    reason?: unknown
    warning?: unknown
  }>,
): Map<string, ParsedErrorEntry> {
  const out = new Map<string, ParsedErrorEntry>()
  for (const e of errors) {
    if (e && typeof e.ark === "string") {
      out.set(e.ark, {
        reason:
          typeof e.reason === "string"
            ? e.reason
            : typeof e.stage === "string"
              ? e.stage
              : "échec",
        warning: e.warning === true,
      })
    }
  }
  return out
}

/**
 * F13 — split an added-ARK list into "succeeded" (should get `indexedAt`
 * stamped) and "failed" (stays out of the index, `indexedAt` null) given the
 * parsed error entries. A `warning` entry does NOT exclude its ARK from
 * succeeded — the doc indexed successfully, it just lost some pages. Pulled
 * out of {@link IngestService.commitPartialFailure} so the decision that
 * matters most (which ARKs get re-indexed) is unit-testable without Prisma.
 */
export function splitSucceededArks(
  addedArks: readonly string[],
  entries: ReadonlyMap<string, ParsedErrorEntry>,
): { succeeded: string[]; failed: string[] } {
  const failed = [...entries.entries()].filter(([, v]) => !v.warning).map(([ark]) => ark)
  const failedSet = new Set(failed)
  const succeeded = addedArks.filter((a) => !failedSet.has(a))
  return { succeeded, failed }
}

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

    // 4b. Paid-OCR opt-in. The `sans_texte` docs are NEVER part of a normal
    // ingest — the regular delta always runs without them. They are folded in
    // ONLY when the user explicitly opts into the spend (confirmPaidOcr) AND the
    // project has budget headroom. Over budget → `budget_exceeded` (a backstop;
    // the UI disables the opt-in when it won't fit). Not opted-in → the paid docs
    // are simply left out and the regular ingest proceeds, never silently sent.
    let paidOcrToInclude: string[] = []
    let paidOcrEstimatedUsd: number | null = null
    if (paidOcrArks.length > 0 && input.confirmPaidOcr) {
      const estimate = await IngestService._estimatePaidOcr(project.id, paidOcrArks)
      const ceilingUsd = IngestService._paidOcrCeilingUsd(project)
      const spentUsd = Number(project.paidOcrSpentUsd)
      if (spentUsd + estimate.usd > ceilingUsd) {
        return { kind: "budget_exceeded", paidOcr: estimate, spentUsd, ceilingUsd }
      }
      paidOcrToInclude = paidOcrArks
      paidOcrEstimatedUsd = estimate.usd
    }

    // Regular delta always; paid-OCR docs only when opted-in within budget.
    const addedArks = [...ingestable, ...paidOcrToInclude]

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
        paidOcrArks: paidOcrToInclude,
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

    // F19: a transport failure here (worker blip, timeout, non-2xx) must NOT
    // leave the QUEUED row from step 8 behind as a corpse — the dedup guard
    // (step 4) would return that same corpse on every future submit for this
    // version, wedging the project's ingestion forever. Mark the job FAILED
    // with an honest transport reason and re-throw so the route still
    // surfaces the error to the caller (the request itself still fails).
    let clusterJobId: string
    try {
      const result = await ClusterRunner.submit({
        projectId: project.id,
        targetVersionId: targetVersion.id,
        appJobId: job.id,
        added: addedDocs,
        removed: removedArks,
        callbackUrl,
        callbackSecret,
      })
      clusterJobId = result.clusterJobId
    } catch (err) {
      await prisma.ingestJob.update({
        where: { id: job.id },
        data: {
          status: INGEST_STATUS.FAILED,
          error: IngestService._truncateError(err),
          finishedAt: new Date(),
        },
      })
      throw err
    }

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
  ): Promise<IngestDeltaPreview> {
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
    const { ingestable, excluded, paidOcr, excludedNoText, excludedNoScan } =
      await IngestService._partitionByIngestability(project.id, deltaAddedArks, {
        paidOcr: project.paidOcrEnabled,
      })

    const paidOcrEstimate = await IngestService._estimatePaidOcr(project.id, paidOcr)
    const ceilingUsd = IngestService._paidOcrCeilingUsd(project)
    const spentUsd = Number(project.paidOcrSpentUsd)

    return {
      already: indexedArks.length,
      added: ingestable.length,
      removed: removedArks.length,
      excluded: excluded.length,
      excludedNoText,
      excludedNoScan,
      paidOcr: paidOcrEstimate,
      paidOcrBudget: {
        spentUsd,
        ceilingUsd,
        withinBudget:
          paidOcrEstimate.docCount > 0 &&
          spentUsd + paidOcrEstimate.usd <= ceilingUsd,
      },
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
   * Fetch the worker's live queue-status read-model for a job, for the Ingérer
   * live view. Returns null when there is nothing to poll — no clusterJobId yet,
   * a terminal job (its live view is moot; the persisted stats tell the story), or
   * the worker is unreachable (best-effort: the page degrades to the banner). The
   * version commit never depends on this — it rides the terminal callback.
   */
  static async queueProgress(job: IngestJob): Promise<ClusterQueueProgress | null> {
    if (!job.clusterJobId) return null
    if (job.status !== INGEST_STATUS.RUNNING && job.status !== INGEST_STATUS.QUEUED) {
      return null
    }
    return ClusterRunner.progress(job.clusterJobId)
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
   *
   * INTERACTION WITH THE WATCHDOG (lib/ingest/watchdog.ts, F18): this method
   * applies unconditionally — it does not check the job's current status
   * before writing. That is intentional. If the watchdog has already marked
   * a wedged job FAILED and the worker's real terminal callback then arrives
   * late (the run actually did finish), this call still commits it to
   * DONE/PARTIAL, overwriting FAILED. Late truth wins on purpose: the
   * watchdog's job is only to stop a stuck row from blocking the dedup guard
   * forever, not to have the final word on outcome.
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
      //
      // F13: derived from `stats.errors[]` directly (not a separate `stats.
      // failed` counter) so a doc that succeeded but only carries a `warning`
      // entry (lost OCR pages, never counted as a failure) can never flip this
      // routing to commitPartialFailure — see countNonWarningErrors.
      const failedCount = countNonWarningErrors(
        IngestService._rawErrors(event.stats as Record<string, unknown>),
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
   *   • Re-annotate Document.indexError for any ARK carrying an F13 `warning`
   *     entry (lost OCR pages) — the doc still indexed, but the librarian sees
   *     why it might have fewer pages than expected.
   *
   * The pointer is also advanced by commitPartialFailure() (a partial run still
   * moves the baseline); only a whole-job failure leaves it. See
   * playbook/corpus-versioning.md invariant 4 and ingestion-jobs.md.
   */
  static async commit(job: IngestJob, results: IngestResults): Promise<void> {
    const now = new Date()
    // Charge the confirmed paid-OCR estimate to the project's running spend,
    // set-once (paidOcrActualUsd null → not yet charged). The estimate (capped
    // page counts) is conservative — it never under-counts spend, which is the
    // safe direction for a budget ceiling. See _chargePaidOcr* helpers.
    const paidOcrCharge = IngestService._paidOcrChargeFor(job)
    // F13: warning-only entries route here (never commitPartialFailure), so the
    // annotation must be applied here too — same transaction, so it's atomic
    // with the indexedAt stamp it rides in on. `commit()` only ever sees
    // warning entries (a real failure would have routed to
    // commitPartialFailure), so every parsed entry here IS a warning.
    const errorEntries = parseErrorEntries(
      IngestService._rawErrors(results.stats as Record<string, unknown>),
    )
    const warningsByArk = new Map(
      [...errorEntries.entries()].map(([ark, v]) => [ark, v.reason] as const),
    )
    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.ingestJob.update({
        where: { id: job.id },
        data: {
          status: INGEST_STATUS.DONE,
          finishedAt: now,
          chunksWritten: results.chunksWritten,
          stats: results.stats as never,
          ...(paidOcrCharge !== null
            ? { paidOcrActualUsd: paidOcrCharge }
            : {}),
        },
      }),
      prisma.corpusVersion.update({
        where: { id: job.targetVersionId },
        data: { status: "ingested" },
      }),
      prisma.project.update({
        where: { id: job.projectId },
        data: {
          ingestedVersionId: job.targetVersionId,
          ...(paidOcrCharge !== null
            ? { paidOcrSpentUsd: { increment: paidOcrCharge } }
            : {}),
        },
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
    ]
    // Applied AFTER the blanket indexError:null above so the annotation
    // survives — indexedAt stays `now` (the doc IS indexed), only indexError
    // carries the warning text.
    for (const [ark, reason] of warningsByArk) {
      ops.push(
        prisma.document.updateMany({
          where: { projectId: job.projectId, ark },
          data: { indexError: reason },
        }),
      )
    }
    await prisma.$transaction(ops)
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
    const entriesByArk = parseErrorEntries(IngestService._rawErrors(stats))
    // F13: only NON-warning entries are real failures — a warning doc (lost
    // OCR pages) still indexed successfully, so it belongs in succeededAdded,
    // not in the excluded/failed set. See splitSucceededArks.
    const { succeeded: succeededAdded } = splitSucceededArks(job.addedArks, entriesByArk)
    const now = new Date()

    // Charge the confirmed paid-OCR estimate even on a partial run: the worker
    // already paid Mistral for the folios it transcribed, and the estimate is
    // conservative. Set-once via paidOcrActualUsd. (A whole-job FAILED, which
    // does not commit, is the one case that escapes accounting — acceptably rare.)
    const paidOcrCharge = IngestService._paidOcrChargeFor(job)

    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.ingestJob.update({
        where: { id: job.id },
        data: {
          status: INGEST_STATUS.PARTIAL,
          finishedAt: now,
          chunksWritten: results.chunksWritten,
          stats: results.stats as never,
          error: `${failed}/${total} document(s) en échec — réessayez les documents échoués`,
          ...(paidOcrCharge !== null ? { paidOcrActualUsd: paidOcrCharge } : {}),
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
        data: {
          ingestedVersionId: job.targetVersionId,
          ...(paidOcrCharge !== null
            ? { paidOcrSpentUsd: { increment: paidOcrCharge } }
            : {}),
        },
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
    // Warning entries are handled in the SECOND loop below, after
    // succeededAdded's blanket indexError:null, so their annotation survives.
    for (const [ark, v] of entriesByArk) {
      if (v.warning) continue
      ops.push(
        prisma.document.updateMany({
          where: { projectId: job.projectId, ark },
          data: { indexError: v.reason },
        }),
      )
    }
    // F13: a warning doc IS in succeededAdded (indexedAt just set to `now`,
    // indexError cleared, above) — re-apply the warning text afterward, in the
    // same transaction, so the doc stays indexed but the reason survives.
    for (const [ark, v] of entriesByArk) {
      if (!v.warning) continue
      ops.push(
        prisma.document.updateMany({
          where: { projectId: job.projectId, ark },
          data: { indexError: v.reason },
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

  /**
   * Defensively extract `stats.errors[]` as an array — `stats` is a loose
   * `Record<string, unknown>` (V1/V2 shapes differ), so this is the one place
   * that trusts it's array-shaped before handing it to {@link parseErrorEntries}.
   */
  private static _rawErrors(
    stats: Record<string, unknown> | null | undefined,
  ): ReadonlyArray<{ ark?: unknown; stage?: unknown; reason?: unknown; warning?: unknown }> {
    const raw = stats?.errors
    return Array.isArray(raw)
      ? (raw as Array<{ ark?: unknown; stage?: unknown; reason?: unknown; warning?: unknown }>)
      : []
  }

  /**
   * Retry failed documents from a previous ingest job.
   *
   * Reads `stats.errors` from the source job for the list of failed ARKs.
   * **F20**: `stats.errors` is absent exactly in the failure modes that most
   * need recovery — a job the watchdog failed after the worker stopped
   * reporting, or one that died before ever emitting a terminal callback,
   * never got a `stats` write. When `stats.errors` is empty, fall back to the
   * per-doc truth: `Document` rows within this job's `addedArks` that never
   * made it into the index (`indexedAt` null) but carry a recorded reason
   * (`indexError` set — written by `commitPartialFailure`). See
   * {@link computeRetryArks} for the pure selection logic.
   *
   * Returns `{ created: false }` only when BOTH sources are empty. Otherwise
   * creates a new ingest job targeting the same version with
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
    // recorded (e.g. FakeClusterRunner stub, or job died/was watchdog-failed
    // before emit).
    const stats = job.stats as Record<string, unknown> | null | undefined
    const rawErrors = stats?.errors
    const statsErrors = Array.isArray(rawErrors)
      ? (rawErrors as { ark: string; stage: string; reason: string }[])
      : []

    // Only queried when stats carried nothing — the common path (a normal
    // partial-failure retry) never touches Document here.
    const docRows =
      statsErrors.length === 0
        ? await prisma.document.findMany({
            where: {
              projectId: job.projectId,
              ark: { in: job.addedArks },
              indexedAt: null,
              indexError: { not: null },
            },
            select: { ark: true, indexedAt: true, indexError: true },
          })
        : []

    const failedArks = computeRetryArks(statsErrors, job.addedArks, docRows)

    if (failedArks.length === 0) return { created: false }

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

    // Same F19 treatment as submit(): a transport failure here must not leave
    // this retry job QUEUED forever either.
    let clusterJobId: string
    try {
      const result = await ClusterRunner.submit({
        projectId: job.projectId,
        targetVersionId: job.targetVersionId,
        appJobId: retryJob.id,
        added: addedDocs,
        removed: [],
        callbackUrl,
        callbackSecret,
      })
      clusterJobId = result.clusterJobId
    } catch (err) {
      await prisma.ingestJob.update({
        where: { id: retryJob.id },
        data: {
          status: INGEST_STATUS.FAILED,
          error: IngestService._truncateError(err),
          finishedAt: new Date(),
        },
      })
      throw err
    }

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
   * Render a caught error as a bounded string for `IngestJob.error` (F19). A
   * raw transport failure can carry headers/stack noise; the UI only needs
   * enough of it to diagnose, and an unbounded string has no business in a
   * column read by the librarian-facing panel.
   */
  private static _truncateError(err: unknown, max = 500): string {
    const message = err instanceof Error ? err.message : String(err)
    return message.length > max ? `${message.slice(0, max)}…` : message
  }

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
  ): Promise<{
    ingestable: string[]
    excluded: string[]
    paidOcr: string[]
    /** Excluded docs digitized but with no readable text (SANS_TEXTE). */
    excludedNoText: number
    /** Excluded docs not digitized at the BnF (NON_NUMERISE). */
    excludedNoScan: number
  }> {
    if (arks.length === 0)
      return {
        ingestable: [],
        excluded: [],
        paidOcr: [],
        excludedNoText: 0,
        excludedNoScan: 0,
      }
    const rows = await prisma.document.findMany({
      where: { projectId, ark: { in: arks } },
      select: {
        ark: true,
        docType: true,
        ocrAvailable: true,
        iiifManifestUrl: true,
        resolveStatus: true,
        lang: true,
      },
    })
    const byArk = new Map(rows.map((r) => [r.ark, r]))

    const ingestable: string[] = []
    const excluded: string[] = []
    const paidOcr: string[] = []
    // Excluded split, for the librarian-facing "ne peuvent pas être ajoutés"
    // line. Only SANS_TEXTE / NON_NUMERISE ever land in `excluded`, so the two
    // counts always sum to excluded.length.
    let excludedNoText = 0
    let excludedNoScan = 0
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
      if (
        opts.paidOcr &&
        confident &&
        cls === INGESTION_CLASS.SANS_TEXTE &&
        isLatinScriptLang(doc.lang)
      ) {
        // Digitized text with no OCR layer, in a script Mistral can faithfully
        // transcribe — eligible for paid OCR once the spend is confirmed.
        // Non-Latin sans_texte falls through to `excluded`: we don't claim to
        // OCR what we can't (see isLatinScriptLang).
        paidOcr.push(ark)
      } else if (!isIngestableClass(cls) && confident) {
        excluded.push(ark)
        if (cls === INGESTION_CLASS.NON_NUMERISE) excludedNoScan++
        else excludedNoText++
      } else {
        ingestable.push(ark)
      }
    }
    return { ingestable, excluded, paidOcr, excludedNoText, excludedNoScan }
  }

  /**
   * The paid-OCR amount to charge a project when this job commits, or null if
   * there is nothing to charge. Set-once: returns null once `paidOcrActualUsd`
   * is already recorded (so a re-delivered commit can't double-charge) or when
   * the job carried no paid-OCR estimate. The number is the confirmed estimate
   * — conservative by design (capped page counts never under-count spend).
   */
  private static _paidOcrChargeFor(job: IngestJob): number | null {
    if (job.paidOcrActualUsd !== null) return null
    if (job.paidOcrEstimatedUsd === null) return null
    return Number(job.paidOcrEstimatedUsd)
  }

  /**
   * Estimate the paid-OCR cost for a set of `sans_texte` ARKs from their stored
   * page counts (`Document.pages`). A missing row or null page count falls back
   * to the conservative default inside estimatePaidOcrCostUsd(). The worker
   * reports the real billed cost on completion.
   */
  /** Effective paid-OCR budget ceiling: the project override, or the default. */
  private static _paidOcrCeilingUsd(project: Project): number {
    return project.paidOcrBudgetUsd === null
      ? PAID_OCR_DEFAULT_BUDGET_USD
      : Number(project.paidOcrBudgetUsd)
  }

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

