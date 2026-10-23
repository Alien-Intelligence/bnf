import "server-only"
// models/ingest/queries.ts
// Pure database access for the IngestJob model. No business logic.
import { prisma } from "@/lib/db"
import { Prisma } from "@/lib/generated/prisma/client"
import type { IngestJob } from "@/lib/generated/prisma/client"
import { INGEST_RECENT_JOBS_LIMIT, PAID_OCR_USD_PER_1K_PAGES } from "@/lib/constants"
import {
  INGEST_ACTIVE_STATUSES,
  INGEST_STATUS,
  ingestJobWithVersions,
  type AdminOcrUsage,
  type IngestJobWithVersions,
  type IngestStatus,
} from "./schema"

export class IngestQueries {
  /** Returns a single job by id; throws when it does not exist. */
  static async getOrThrow(id: string): Promise<IngestJob> {
    return prisma.ingestJob.findUniqueOrThrow({ where: { id } })
  }

  /** Inserts a job row. */
  static async create(data: Prisma.IngestJobUncheckedCreateInput): Promise<IngestJob> {
    return prisma.ingestJob.create({ data })
  }

  /** Updates a job row by id; throws when it does not exist. */
  static async update(id: string, data: Prisma.IngestJobUncheckedUpdateInput): Promise<IngestJob> {
    return prisma.ingestJob.update({ where: { id }, data })
  }

  /**
   * Updates a job row only while it is still in `expectedStatus`, so a job that
   * went terminal since the caller looked is never overwritten. Matching no row
   * is not an error.
   */
  static async updateIfStatus(
    id: string,
    expectedStatus: IngestStatus,
    data: Prisma.IngestJobUncheckedUpdateManyInput,
  ): Promise<void> {
    await prisma.ingestJob.updateMany({ where: { id, status: expectedStatus }, data })
  }

  /**
   * Runs the given statements as one atomic batch transaction and returns
   * their results in order. The statements are built by the owning models'
   * queries; this model only opens the transaction.
   */
  static batch<P extends Prisma.PrismaPromise<unknown>[]>(ops: [...P]) {
    return prisma.$transaction(ops)
  }

  /** Statement: insert a job row (for composition in {@link batch}). */
  static createOp(data: Prisma.IngestJobUncheckedCreateInput) {
    return prisma.ingestJob.create({ data })
  }

  /** Statement: update a job row (for composition in {@link batch}). */
  static updateOp(id: string, data: Prisma.IngestJobUncheckedUpdateInput) {
    return prisma.ingestJob.update({ where: { id }, data })
  }

  /** Returns a single job by id, or null if not found. */
  static async get(id: string): Promise<IngestJob | null> {
    return prisma.ingestJob.findUnique({ where: { id } })
  }

  /**
   * Returns the most recent jobs for a project, newest first.
   * Defaults to INGEST_RECENT_JOBS_LIMIT rows.
   */
  static async listForProject(
    projectId: string,
    limit = INGEST_RECENT_JOBS_LIMIT,
  ): Promise<IngestJobWithVersions[]> {
    return prisma.ingestJob.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: limit,
      ...ingestJobWithVersions,
    })
  }

  /**
   * Returns the single active (queued or running) job for a project, or null.
   * There should be at most one due to the soft uniqueness check in submit().
   */
  static async activeForProject(projectId: string): Promise<IngestJob | null> {
    return prisma.ingestJob.findFirst({
      where: { projectId, status: { in: [...INGEST_ACTIVE_STATUSES] } },
    })
  }

  /**
   * Returns the active job for a given (projectId, targetVersionId) pair, or null.
   * Used by IngestService.submit() for deduplication.
   */
  static async findByTarget(
    projectId: string,
    targetVersionId: string,
  ): Promise<IngestJob | null> {
    return prisma.ingestJob.findFirst({
      where: {
        projectId,
        targetVersionId,
        status: { in: [...INGEST_ACTIVE_STATUSES] },
      },
    })
  }

  /**
   * Candidate jobs for the ingest watchdog (lib/ingest/watchdog.ts, F18): every
   * RUNNING job with a clusterJobId to poll, plus QUEUED jobs old enough to be
   * an F19 submit-corpse (a job row inserted but never transitioned to RUNNING
   * — closed at the source now, but a row written before that fix could still
   * exist). This is a coarse pre-filter to keep the scan small; the watchdog's
   * own decision function re-checks age/clusterJobId so correctness never
   * depends on this query alone.
   */
  static async watchdogCandidates(queuedCutoff: Date): Promise<IngestJob[]> {
    return prisma.ingestJob.findMany({
      where: {
        OR: [
          { status: INGEST_STATUS.RUNNING, clusterJobId: { not: null } },
          { status: INGEST_STATUS.QUEUED, createdAt: { lt: queuedCutoff } },
        ],
      },
    })
  }

  /**
   * Paid-OCR (Mistral) spend and ingest volume across every project, for the
   * admin OCR tab. `Project.paidOcrSpentUsd` is the authoritative cumulative
   * spend (set-once per job on commit); the paid jobs supply per-job detail and
   * the doc/page counts. Only jobs that actually slated paid OCR (non-empty
   * `paidOcrArks`) are included. Total pages are derived from spend at the fixed
   * per-1k-page rate. Admin gate lives at the route.
   */
  static async adminOcrUsage(recentLimit = 50): Promise<AdminOcrUsage> {
    const [projects, jobs] = await Promise.all([
      prisma.project.findMany({
        select: {
          id: true,
          name: true,
          paidOcrSpentUsd: true,
          paidOcrBudgetUsd: true,
          owner: { select: { email: true } },
        },
      }),
      prisma.ingestJob.findMany({
        where: { paidOcrArks: { isEmpty: false } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          projectId: true,
          status: true,
          createdAt: true,
          finishedAt: true,
          paidOcrArks: true,
          paidOcrEstimatedUsd: true,
          paidOcrActualUsd: true,
          chunksWritten: true,
        },
      }),
    ])

    const nameById = new Map(projects.map((p) => [p.id, p.name]))

    // Per-project paid-job tallies.
    const tally = new Map<string, { count: number; docs: number }>()
    for (const j of jobs) {
      const t = tally.get(j.projectId) ?? { count: 0, docs: 0 }
      t.count += 1
      t.docs += j.paidOcrArks.length
      tally.set(j.projectId, t)
    }

    const projectStats = projects
      .map((p) => ({
        projectId: p.id,
        projectName: p.name,
        ownerEmail: p.owner.email,
        spentUsd: Number(p.paidOcrSpentUsd),
        budgetUsd: p.paidOcrBudgetUsd === null ? null : Number(p.paidOcrBudgetUsd),
        paidJobCount: tally.get(p.id)?.count ?? 0,
        paidOcrDocs: tally.get(p.id)?.docs ?? 0,
      }))
      // Only projects that ever spent or ran a paid-OCR job.
      .filter((p) => p.spentUsd > 0 || p.paidJobCount > 0)
      .sort((a, b) => b.spentUsd - a.spentUsd)

    const totalSpent = projects.reduce((s, p) => s + Number(p.paidOcrSpentUsd), 0)

    const recentJobs = jobs.slice(0, recentLimit).map((j) => ({
      id: j.id,
      projectId: j.projectId,
      projectName: nameById.get(j.projectId) ?? j.projectId,
      status: j.status,
      createdAt: j.createdAt.toISOString(),
      finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
      paidOcrDocs: j.paidOcrArks.length,
      estimatedUsd:
        j.paidOcrEstimatedUsd === null ? null : Number(j.paidOcrEstimatedUsd),
      actualUsd: j.paidOcrActualUsd === null ? null : Number(j.paidOcrActualUsd),
      chunksWritten: j.chunksWritten,
    }))

    return {
      totals: {
        spentUsd: totalSpent,
        paidJobs: jobs.length,
        paidOcrDocs: jobs.reduce((s, j) => s + j.paidOcrArks.length, 0),
        pagesApprox: Math.round((totalSpent / PAID_OCR_USD_PER_1K_PAGES) * 1000),
      },
      projects: projectStats,
      recentJobs,
    }
  }
}
