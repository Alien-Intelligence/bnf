// models/corpus/service.ts
// Business logic for corpus mutations. Orchestrates advisory locking,
// advanceVersion(), and snapshot construction.
//
// Slice 1 note: MCP resolve is NOT wired here. addArks() assumes every ARK in
// the input already has a Document row (created by the seed or a prior add).
// If an ARK has no Document row, it throws — MCP resolve lands in slice 3.
import "server-only"

import { prisma } from "@/lib/db"
import type { Project } from "@/models/projects/schema"
import type { User } from "@/models/users/schema"
import { CorpusQueries } from "./queries"
import { type CorpusSnapshot } from "./schema"
import { advanceVersion } from "./versioning"
import type { AddToCorpusInput, RemoveFromCorpusInput } from "./types"

/** Return shape for mutating operations — snapshot + delta counters. */
export type CorpusMutationResult = CorpusSnapshot & {
  lastDeltaAdded: number
  lastDeltaRemoved: number
}

export class CorpusService {
  /**
   * Adds ARKs to the project's corpus.
   *
   * Steps:
   *   1. Open a serialisable transaction.
   *   2. Acquire a per-project advisory lock so concurrent mutations produce
   *      strictly monotonic seqs (invariant 6).
   *   3. Read the current head version and its membership.
   *   4. Filter out ARKs that are already members (no-op detection at the
   *      service level; advanceVersion() also short-circuits on empty deltas).
   *   5. Verify every new ARK has a Document row — throw if not (MCP resolve
   *      lands in slice 3; until then the seed pre-creates the rows).
   *   6. Call advanceVersion() to seal the new version.
   *   7. Return the new snapshot + counters.
   *
   * Advisory lock SQL:
   *   SELECT pg_advisory_xact_lock(hashtext($1))
   * where $1 is `project:<projectId>`. Held for the duration of the
   * transaction, released automatically on commit/rollback.
   */
  static async addArks(
    project: Project,
    user: User,
    input: AddToCorpusInput,
  ): Promise<CorpusMutationResult> {
    const projectId = project.id

    return prisma.$transaction(async (tx) => {
      // --- Advisory lock (invariant 6) ----------------------------------------
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`project:${projectId}`}))`

      // --- Current head and membership ----------------------------------------
      const head = await CorpusQueries.headVersion(projectId)
      const existingSet = new Set(head.membership.map((m) => m.ark))

      // --- Filter to genuinely new ARKs ---------------------------------------
      const newArks = input.arks.filter((a) => !existingSet.has(a))

      // No-op: all ARKs already present — return current snapshot unchanged.
      if (newArks.length === 0) {
        const snapshot = await CorpusQueries.snapshot(projectId, "head")
        return { ...snapshot, lastDeltaAdded: 0, lastDeltaRemoved: 0 }
      }

      // --- Verify Document rows exist (slice 1 constraint) --------------------
      // Slice 3 will call bnf.resolve() via MCP to create Document rows for
      // unknown ARKs. Until then, every ARK must already exist.
      const existingDocs = await tx.document.findMany({
        where: {
          projectId,
          ark: { in: newArks },
        },
        select: { ark: true },
      })
      const resolvedSet = new Set(existingDocs.map((d) => d.ark))
      const missingArks = newArks.filter((a) => !resolvedSet.has(a))

      if (missingArks.length > 0) {
        throw new Error(
          `Cannot add ARKs with no Document row (MCP resolve lands in slice 3): ${missingArks.slice(0, 5).join(", ")}${missingArks.length > 5 ? ` … and ${missingArks.length - 5} more` : ""}`,
        )
      }

      // --- Advance the version ------------------------------------------------
      await advanceVersion(tx, projectId, head, {
        addArks: newArks,
        removeArks: [],
        createdBy: `user:${user.id}`,
        note: input.reason,
      })

      // --- Build and return the new snapshot ----------------------------------
      // We read snapshot outside the tx here to avoid a nested read in the
      // same tx (snapshot uses prisma singleton). However, since we are still
      // inside prisma.$transaction, we must use the tx client for consistency.
      // Re-fetch the head inside tx so snapshot reflects the new version.
      const newHead = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { headVersionId: true },
      })

      if (!newHead.headVersionId) {
        throw new Error(`headVersionId missing after advanceVersion — bug`)
      }

      const newVersion = await tx.corpusVersion.findUniqueOrThrow({
        where: { id: newHead.headVersionId },
        select: { seq: true, status: true },
      })

      const total = await tx.corpusMembership.count({
        where: { versionId: newHead.headVersionId },
      })

      // Facets and sample need a full snapshot — call snapshot() outside the tx
      // after commit by returning the versionId and building it post-tx. But to
      // keep the API consistent we return a lightweight snapshot here and let
      // the caller re-fetch if needed. For now we build it within the tx:
      const snapshot = await CorpusQueries.snapshot(projectId, "head")

      return {
        ...snapshot,
        versionSeq: newVersion.seq,
        versionStatus: newVersion.status as CorpusSnapshot["versionStatus"],
        total,
        lastDeltaAdded: newArks.length,
        lastDeltaRemoved: 0,
      }
    })
  }

  /**
   * Removes ARKs from the project's corpus.
   *
   * Steps:
   *   1. Open a transaction + acquire advisory lock.
   *   2. Determine which of the supplied ARKs are actually in the head.
   *   3. No-op if none of the supplied ARKs are present.
   *   4. Call advanceVersion() with removeArks.
   *   5. Return the new snapshot + counters.
   *
   * Removing an ARK does NOT delete the Document row — membership change only
   * (corpus-versioning.md invariant: "Document rows live forever").
   */
  static async removeArks(
    project: Project,
    user: User,
    input: RemoveFromCorpusInput,
  ): Promise<CorpusMutationResult> {
    const projectId = project.id

    return prisma.$transaction(async (tx) => {
      // --- Advisory lock (invariant 6) ----------------------------------------
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`project:${projectId}`}))`

      // --- Current head and membership ----------------------------------------
      const head = await CorpusQueries.headVersion(projectId)
      const existingSet = new Set(head.membership.map((m) => m.ark))

      // --- Filter to ARKs actually in the head --------------------------------
      const toRemove = input.arks.filter((a) => existingSet.has(a))

      // No-op: none of the supplied ARKs are members.
      if (toRemove.length === 0) {
        const snapshot = await CorpusQueries.snapshot(projectId, "head")
        return { ...snapshot, lastDeltaAdded: 0, lastDeltaRemoved: 0 }
      }

      // --- Advance the version ------------------------------------------------
      await advanceVersion(tx, projectId, head, {
        addArks: [],
        removeArks: toRemove,
        createdBy: `user:${user.id}`,
        note: input.reason,
      })

      // --- Build and return the snapshot --------------------------------------
      const snapshot = await CorpusQueries.snapshot(projectId, "head")

      return {
        ...snapshot,
        lastDeltaAdded: 0,
        lastDeltaRemoved: toRemove.length,
      }
    })
  }
}
