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

import type { CorpusVersion, Prisma } from "@/lib/generated/prisma/client"
import { SessionQueries } from "@/models/sessions/queries"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import { CorpusQueries } from "./queries"
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
): Promise<CorpusVersion> {
  // --- No-op short-circuit ---------------------------------------------------
  // Invariant: a no-op delta must NOT create a new version. Return parent
  // unchanged so the service can return the existing snapshot.
  if (delta.addArks.length === 0 && delta.removeArks.length === 0) {
    return parent
  }

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
  // Full membership = carried from parent + newly added ARKs. The carried part
  // is copied inside the database in ONE statement (never through Node: a
  // large corpus is tens of thousands of rows), from the committed parent
  // state the caller's advisory lock protects. projectId is denormalized on each
  // row for filter-performance (see schema).
  await CorpusQueries.copyMembership(tx, {
    fromVersionId: parent.id,
    toVersionId: next.id,
    excludeArks: delta.removeArks,
  })
  if (delta.addArks.length > 0) {
    await tx.corpusMembership.createMany({
      data: delta.addArks.map((ark) => ({ versionId: next.id, ark, projectId })),
    })
  }

  // --- Swing the head pointer ------------------------------------------------
  // headVersionId is ONLY ever moved here — no other code path touches it
  // (per playbook/corpus-versioning.md forbidden patterns).
  await tx.project.update({
    where: { id: projectId },
    data: { headVersionId: next.id },
  })

  // The corpus prompt embeds the head ("Version N — X document(s)" and its
  // facets): every corpus session of this project — and of the workspaces
  // reading its corpus — is stale once the head moves. Invalidated in the
  // SAME transaction, so a commit, an add or a removal can never leave a
  // cached prompt describing the previous head.
  await SessionQueries.invalidatePrompts(
    { projectId, scope: SESSION_SCOPE.CORPUS, withDerived: true },
    tx,
  )

  return next
}
