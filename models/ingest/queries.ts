import "server-only"
// models/ingest/queries.ts
// Pure database access for the IngestJob model. No business logic.
import { prisma } from "@/lib/db"
import { Prisma } from "@/lib/generated/prisma/client"
import type { IngestJob } from "@/lib/generated/prisma/client"

/** An IngestJob row with its base/target version seqs joined (for the history). */
export type IngestJobWithVersions = Prisma.IngestJobGetPayload<{
  include: {
    targetVersion: { select: { seq: true } }
    baseVersion: { select: { seq: true } }
  }
}>

export class IngestQueries {
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
    limit = 20,
  ): Promise<IngestJobWithVersions[]> {
    return prisma.ingestJob.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: limit,
      // Join the base/target version seqs so the history can show "v10 → v15".
      include: {
        targetVersion: { select: { seq: true } },
        baseVersion: { select: { seq: true } },
      },
    })
  }

  /**
   * Returns the single active (queued or running) job for a project, or null.
   * There should be at most one due to the soft uniqueness check in submit().
   */
  static async activeForProject(projectId: string): Promise<IngestJob | null> {
    return prisma.ingestJob.findFirst({
      where: { projectId, status: { in: ["queued", "running"] } },
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
        status: { in: ["queued", "running"] },
      },
    })
  }
}
