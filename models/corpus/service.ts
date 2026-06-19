// models/corpus/service.ts
// Business logic for corpus mutations. Orchestrates advisory locking,
// advanceVersion(), and snapshot construction.
//
// addArks() adds ARKs INSTANTLY: ARKs without a Document row are inserted as
// "stub" rows (resolveStatus="pending") carrying only what's derivable from the
// ARK itself; their BnF metadata is resolved out-of-band by the background
// resolver (lib/documents/resolver.ts). The corpus is therefore never coupled
// to MCP availability/latency. The caller (tool/route) kicks the drainer after
// the response is sent.
import "server-only"

import { prisma } from "@/lib/db"
import { sourceFromArk } from "@/lib/mcp/vocab"
import { DocumentService } from "@/models/documents/service"
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

/**
 * An ARK that was added to the corpus but has no digitized full text / IIIF
 * manifest (e.g. a catalogue notice). It is a valid corpus member, but it will
 * be skipped at ingestion time — the corpus can hold it, the RAG index cannot.
 * Derived from the ARK itself, so it is known instantly (no MCP round-trip).
 */
export type NonIngestableDocument = {
  ark: string
  source: string
}

/**
 * Result of addArks(). Extends the mutation result with:
 *   - `pending`       — how many of the added ARKs are newly-created stubs whose
 *                       metadata is still resolving in the background.
 *   - `nonIngestable` — added ARKs without digitized full text (no RAG ingest
 *                       later). The real ingestion filter runs at ingest time;
 *                       this is an early heads-up derived from the ARK prefix.
 */
export type CorpusAddResult = CorpusMutationResult & {
  pending: number
  nonIngestable: NonIngestableDocument[]
  /** Number of ARKs supplied in the call (before dedup). */
  requested: number
  /** Supplied ARKs NOT newly added: already in the corpus or repeated in the
   *  same call. `requested === lastDeltaAdded + duplicates`. The caller passes
   *  every found ARK and lets the service dedup — it never pre-filters. */
  duplicates: number
}

export class CorpusService {
  /**
   * Adds ARKs to the project's corpus INSTANTLY — no MCP round-trip.
   *
   * Two phases, deliberately split so the advisory lock is held only for the
   * version advance:
   *
   * Phase 1 — stub (NO lock, no network):
   *   ARKs without a Document row are inserted as "stub" rows
   *   (resolveStatus="pending") carrying only what's derivable from the ARK
   *   (source + IIIF manifest URL). Their BnF metadata is resolved out-of-band
   *   by the background resolver — the caller kicks it after the response.
   *
   * Phase 2 — advance (tx + per-project advisory lock):
   *   Acquire `pg_advisory_xact_lock(hashtext('project:<id>'))` (invariant 6).
   *   Add the input ARKs not already members of head — every input ARK now has
   *   a Document row, so the corpus_membership FK is satisfied. advanceVersion()
   *   seals the new version; seq/status/total are captured INSIDE the tx so the
   *   result is correct under concurrency.
   *
   * After commit, the comprehension snapshot is built from the committed head;
   * its versionSeq/status/total are overridden with the tx-captured values so
   * two concurrent adds report their own distinct versions.
   */
  static async addArks(
    project: Project,
    user: User,
    input: AddToCorpusInput,
  ): Promise<CorpusAddResult> {
    const projectId = project.id

    // Dedupe the supplied ARKs up front: the caller is encouraged to fire every
    // ARK it found without cross-referencing the corpus itself, so the same ARK
    // may appear twice in one call. Deduping here also prevents a duplicate
    // (versionId, ark) PK violation in advanceVersion's createMany.
    const requested = input.arks.length
    const uniqueArks = [...new Set(input.arks)]

    // === Phase 1: create stub rows for unknown ARKs (no lock, no network) =====
    // Idempotent: ARKs that already have a row (stub or resolved) are untouched.
    // Returns the ARKs newly inserted as pending stubs.
    const newStubArks = await DocumentService.createStubs(projectId, uniqueArks)
    const newStubSet = new Set(newStubArks)

    // === Phase 2: advance the version (tx + advisory lock) ====================
    const advance = await prisma.$transaction(async (tx) => {
      // --- Advisory lock (invariant 6) --------------------------------------
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`project:${projectId}`}))`

      // --- Current head and membership --------------------------------------
      const head = await CorpusQueries.headVersion(projectId)
      const memberSet = new Set(head.membership.map((m) => m.ark))

      // Add input ARKs not already members. Every input ARK now has a Document
      // row (resolved already, or a stub just created), so the membership FK
      // holds for all of them.
      const addArks = uniqueArks.filter((a) => !memberSet.has(a))

      const newVersion = await advanceVersion(tx, projectId, head, {
        addArks,
        removeArks: [],
        createdBy: `user:${user.id}`,
        note: input.reason,
      })

      const total = await tx.corpusMembership.count({
        where: { versionId: newVersion.id },
      })

      return {
        addedArks: addArks,
        versionSeq: newVersion.seq,
        versionStatus: newVersion.status as CorpusSnapshot["versionStatus"],
        total,
      }
    })

    // --- Build the comprehension snapshot from the committed head -------------
    const snapshot = await CorpusQueries.snapshot(projectId, "head")

    // Flag added ARKs with no digitized full text → not ingestable later. The
    // real filter runs at ingestion; gallica is the only source with a derived
    // IIIF manifest, so anything else (catalogue, other) is non-ingestable.
    const nonIngestable: NonIngestableDocument[] = advance.addedArks
      .map((ark) => ({ ark, source: sourceFromArk(ark) }))
      .filter((d) => d.source !== "gallica")

    // How many of the docs added this call are still resolving in the background.
    const pending = advance.addedArks.filter((a) => newStubSet.has(a)).length

    return {
      ...snapshot,
      versionSeq: advance.versionSeq,
      versionStatus: advance.versionStatus,
      total: advance.total,
      lastDeltaAdded: advance.addedArks.length,
      lastDeltaRemoved: 0,
      pending,
      nonIngestable,
      requested,
      duplicates: requested - advance.addedArks.length,
    }
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

    const advance = await prisma.$transaction(async (tx) => {
      // --- Advisory lock (invariant 6) ----------------------------------------
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`project:${projectId}`}))`

      // --- Current head and membership ----------------------------------------
      const head = await CorpusQueries.headVersion(projectId)
      const existingSet = new Set(head.membership.map((m) => m.ark))

      // --- Filter to ARKs actually in the head --------------------------------
      const toRemove = input.arks.filter((a) => existingSet.has(a))

      // advanceVersion returns the new version, or `head` unchanged when
      // toRemove is empty (no-op). Capture seq/status/total inside the tx so the
      // result is correct under concurrency (and not a stale singleton read).
      const newVersion = await advanceVersion(tx, projectId, head, {
        addArks: [],
        removeArks: toRemove,
        createdBy: `user:${user.id}`,
        note: input.reason,
      })

      const total = await tx.corpusMembership.count({
        where: { versionId: newVersion.id },
      })

      return {
        removed: toRemove.length,
        versionSeq: newVersion.seq,
        versionStatus: newVersion.status as CorpusSnapshot["versionStatus"],
        total,
      }
    })

    // Build the comprehension snapshot from the committed head; override the
    // counters with the tx-captured values.
    const snapshot = await CorpusQueries.snapshot(projectId, "head")

    return {
      ...snapshot,
      versionSeq: advance.versionSeq,
      versionStatus: advance.versionStatus,
      total: advance.total,
      lastDeltaAdded: 0,
      lastDeltaRemoved: advance.removed,
    }
  }
}
