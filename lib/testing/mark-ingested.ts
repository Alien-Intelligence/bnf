// lib/testing/mark-ingested.ts
// Puts a project's head version into the ingested state WITHOUT a cluster
// round-trip, for fixtures that need "this corpus is ingested" as a
// precondition rather than as the thing under test.
//
// Test-only: never call this from app code. In the application there is exactly
// one writer of `project.ingestedVersionId` — `IngestService.commit()` and its
// partial/no-op siblings — and playbook/ingestion-jobs.md forbids any other,
// because a pointer that moves independently of the pipeline is a pointer that
// can disagree with what the cluster actually holds.
//
// The reason this helper exists rather than a bare `prisma.project.update`:
// the pointer is half of a pair. Moving it alone leaves the CorpusVersion at
// `sealed` while the project claims it is ingested — a state the real pipeline
// can never produce, which then makes every fixture built on it subtly unlike
// production. Both halves move here, in one transaction, the same way
// `_commitNoOp` moves them.
import "server-only"

import { prisma } from "@/lib/db"
import { CORPUS_VERSION_STATUS } from "@/models/corpus/schema"

/**
 * Advance `ingestedVersionId` to the project's current head and flip that
 * version to `ingested`. Returns the version id now pointed at.
 *
 * Throws when the project has no head — a project always has one
 * (corpus-versioning.md invariant 1), so its absence means the fixture is
 * malformed and silently doing nothing would hide that.
 */
export async function markHeadIngested(projectId: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { headVersionId: true },
    })
    if (!project.headVersionId) {
      throw new Error(
        `markHeadIngested: project ${projectId} has no head version`,
      )
    }

    await tx.corpusVersion.update({
      where: { id: project.headVersionId },
      data: { status: CORPUS_VERSION_STATUS.INGESTED },
    })
    await tx.project.update({
      where: { id: projectId },
      data: { ingestedVersionId: project.headVersionId },
    })

    return project.headVersionId
  })
}
