import "server-only"
// models/ingest/service.ts
// Business logic for the ingestion lifecycle.
//
// INVARIANTS (enforced here, never elsewhere):
//   • project.ingestedVersionId is moved ONLY by IngestService.commit().
//   • The no-op short-circuit (added=[] && removed=[]) creates a done job and
//     advances bookkeeping in a single atomic transaction without calling the cluster.
//   • Deduplication: if a (projectId, targetVersionId) job is already queued/running,
//     IngestService.submit() returns the existing job — no new row.
import crypto from "node:crypto"
import { prisma } from "@/lib/db"
import type { IngestJob, Project, User } from "@/lib/generated/prisma/client"
import { CorpusQueries } from "@/models/corpus/queries"
import { INGEST_STATUS } from "./schema"
import type { IngestResults, IngestSubmitInput } from "./types"
import type { ClusterProgressEvent } from "@/lib/cluster/contracts"
import { ClusterRunner } from "@/lib/cluster/runner"
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
   *   5. No-op short-circuit: if delta is empty, create a done job + advance
   *      ingestedVersionId atomically. No cluster call.
   *   6. Insert job row, enqueue to cluster runner.
   */
  static async submit(
    project: Project,
    user: User,
    input: IngestSubmitInput,
  ): Promise<IngestJob> {
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

    // 2. Resolve base version
    const baseVersion = await CorpusQueries.ingestedVersion(project.id)

    // 3. Compute delta
    const targetArks = await CorpusQueries.membershipArks(targetVersion.id)
    const baseArks = baseVersion
      ? await CorpusQueries.membershipArks(baseVersion.id)
      : []

    const baseSet = new Set(baseArks)
    const targetSet = new Set(targetArks)

    const addedArks = targetArks.filter((a) => !baseSet.has(a))
    const removedArks = baseArks.filter((a) => !targetSet.has(a))

    // 4. Deduplication guard
    const existing = await prisma.ingestJob.findFirst({
      where: {
        projectId: project.id,
        targetVersionId: targetVersion.id,
        status: { in: [INGEST_STATUS.QUEUED, INGEST_STATUS.RUNNING] },
      },
    })
    if (existing) return existing

    // 5. No-op short-circuit
    if (addedArks.length === 0 && removedArks.length === 0) {
      return IngestService._commitNoOp(project, user, targetVersion.id, baseVersion?.id ?? null)
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
        callbackSecret,
      },
    })

    // 9. Enqueue to cluster runner (fire-and-forget; route handles progress via callback)
    const callbackUrl = `${env.APP_URL}/api/internal/ingest/${job.id}/progress`

    const { clusterJobId } = await ClusterRunner.submit({
      projectId: project.id,
      targetVersionId: targetVersion.id,
      added: addedDocs,
      removed: removedArks,
      callbackUrl,
      callbackSecret,
    })

    // 10. Persist clusterJobId and transition to running
    return prisma.ingestJob.update({
      where: { id: job.id },
      data: {
        clusterJobId,
        status: INGEST_STATUS.RUNNING,
        startedAt: new Date(),
      },
    })
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
      await IngestService.commit(job, {
        chunksWritten: event.chunksWritten,
        stats: event.stats,
      })
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
   *
   * THIS IS THE ONLY PLACE THAT MOVES project.ingestedVersionId.
   * See playbook/corpus-versioning.md invariant 4 and ingestion-jobs.md.
   */
  static async commit(job: IngestJob, results: IngestResults): Promise<void> {
    await prisma.$transaction([
      prisma.ingestJob.update({
        where: { id: job.id },
        data: {
          status: INGEST_STATUS.DONE,
          finishedAt: new Date(),
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
    ])
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

    const callbackUrl = `${env.APP_URL}/api/internal/ingest/${retryJob.id}/progress`

    const { clusterJobId } = await ClusterRunner.submit({
      projectId: job.projectId,
      targetVersionId: job.targetVersionId,
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
      lang: doc.lang,
      source: doc.source ?? "unknown",
      iiifManifestUrl: doc.iiifManifestUrl,
    }))
  }
}

