// models/corpus/versioning.ts
// The single function that creates new CorpusVersion rows.
//
// RULES (from playbook/corpus-versioning.md):
//   - advanceVersion() is the ONLY place that creates new CorpusVersion rows.
//   - headVersionId on Project is ONLY moved here.
//   - A no-op delta (nothing added, nothing removed) returns parent unchanged
//     and does NOT create a new version.
//   - Must run inside a prisma.$transaction (started by the calling service).
//   - Invariants 1-6 from playbook/corpus-versioning.md must hold at all times.
import "server-only"

import { Prisma } from "@/lib/generated/prisma/client"
import { CORPUS_VERSION_STATUS, type CorpusVersionWithArks } from "./schema"

/**
 * Input to advanceVersion. The calling service computes addArks / removeArks
 * before entering the transaction.
 */
export type AdvanceVersionDelta = {
  /** ARKs to include in the new version that are not in the parent. */
  addArks: string[]
  /** ARKs present in the parent to exclude from the new version. */
  removeArks: string[]
  /** Stable identity of the actor: "agent:session:<sid>" | "user:<uid>" */
  createdBy: string
  /** Optional human-readable reason for the version (stored as note). */
  note?: string
}

/**
 * Creates a new sealed CorpusVersion that carries forward all membership from
 * `parent` minus `delta.removeArks`, then adds `delta.addArks`. Atomically
 * swings `Project.headVersionId` to the new version's id.
 *
 * Returns `parent` unchanged when the delta is a no-op (both addArks and
 * removeArks are empty). This keeps the version stream meaningful — one entry
 * per actual change.
 *
 * Must be called inside a `prisma.$transaction` callback. The `tx` argument is
 * the transactional client provided by Prisma; the advisory lock should be
 * acquired by the service BEFORE calling this function (see
 * playbook/corpus-versioning.md §Concurrency).
 *
 * @param tx        Prisma transactional client (Prisma.TransactionClient).
 * @param projectId The project whose corpus is being mutated.
 * @param parent    The current head version, with membership ARKs included.
 * @param delta     What to add, what to remove, and who is making the change.
 */
export async function advanceVersion(
  tx: Prisma.TransactionClient,
  projectId: string,
  parent: CorpusVersionWithArks,
  delta: AdvanceVersionDelta,
): Promise<CorpusVersionWithArks> {
  // --- No-op short-circuit ---------------------------------------------------
  // Invariant: a no-op delta must NOT create a new version. Return parent
  // unchanged so the service can return the existing snapshot.
  if (delta.addArks.length === 0 && delta.removeArks.length === 0) {
    return parent
  }

  // --- Compute the carried membership ----------------------------------------
  // Start from the parent's full membership and subtract the removed set.
  // We re-read from the DB via the tx to be consistent with the locked state,
  // even though the parent argument already carries the arks. This ensures that
  // if the parent was fetched outside the transaction, we still see the
  // committed state.
  const removedSet = new Set(delta.removeArks)
  const parentMembership = await tx.corpusMembership.findMany({
    where: { versionId: parent.id },
    select: { ark: true },
  })
  const carried = parentMembership
    .map((r) => r.ark)
    .filter((a) => !removedSet.has(a))

  // --- Create the new version ------------------------------------------------
  // seq is parent.seq + 1 (monotonic per project — invariant 2).
  // status is SEALED immediately (corpus_membership rows land in the same tx).
  const next = await tx.corpusVersion.create({
    data: {
      projectId,
      seq: parent.seq + 1,
      status: CORPUS_VERSION_STATUS.SEALED,
      parentId: parent.id,
      createdBy: delta.createdBy,
      note: delta.note ?? null,
    },
  })

  // --- Materialise membership ------------------------------------------------
  // Full membership = carried from parent + newly added ARKs.
  // projectId is denormalized on each row for filter-performance (see schema).
  const members = [...carried, ...delta.addArks].map((ark) => ({
    versionId: next.id,
    ark,
    projectId,
  }))

  if (members.length > 0) {
    await tx.corpusMembership.createMany({ data: members })
  }

  // --- Swing the head pointer ------------------------------------------------
  // headVersionId is ONLY ever moved here — no other code path touches it
  // (per playbook/corpus-versioning.md forbidden patterns).
  await tx.project.update({
    where: { id: projectId },
    data: { headVersionId: next.id },
  })

  // Return the new version with its membership so callers can build snapshots.
  return tx.corpusVersion.findUniqueOrThrow({
    where: { id: next.id },
    include: { membership: { select: { ark: true } } },
  })
}
