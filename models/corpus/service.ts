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

import { BnfDirectClient } from "@/lib/bnf/direct"
import { BNF_CANONICALIZE_BUDGET_MS } from "@/lib/constants"
import { prisma } from "@/lib/db"
import { sourceFromArk } from "@/lib/mcp/vocab"
import {
  DOCUMENT_CANONICAL_STATUS,
  type DocumentCanonicalStatus,
} from "@/models/documents/schema"
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

/**
 * Result of promoteNotice() — the on-demand cb→Gallica upgrade.
 *   - status "upgraded"      — the notice was replaced by its digitized doc;
 *                              `canonical` is the new member, a new version was
 *                              sealed, `pendingResolve` flags a fresh stub.
 *   - status "not_digitized" — confirmed no Gallica reproduction (notice kept).
 *   - status "api_error"     — BnF still flaky; try again later (notice kept).
 *   - status "not_catalogue" — the ARK is not a `cb…` notice (nothing to do).
 */
export type CorpusPromoteResult =
  | {
      promoted: true
      status: "upgraded"
      canonical: string
      versionSeq: number
      total: number
      pendingResolve: boolean
    }
  | { promoted: false; status: "not_digitized" | "api_error" | "not_catalogue" }

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
   *
   * `sessionId` (optional) — the agent session performing the add. When given,
   * a CorpusContribution row is recorded for EVERY supplied (deduped) ARK, not
   * only the newly-added ones: a duplicate re-added from another session must be
   * tagged with that session too (multi-session attribution). The composite PK
   * dedupes same-session re-adds. Seed / API paths without a session skip this.
   */
  static async addArks(
    project: Project,
    user: User,
    input: AddToCorpusInput,
    sessionId?: string,
    opts?: { canonicalize?: boolean },
  ): Promise<CorpusAddResult> {
    const projectId = project.id

    // `requested` is what the caller actually supplied — counted BEFORE any
    // canonicalization or dedup, so the agent's "you added N" matches its input.
    const requested = input.arks.length

    // === Phase 0: canonicalize catalogue notices to their digitized doc =======
    // A `cb…` notice that the BnF has digitized is replaced by its Gallica ARK
    // (bpt6k…/btv1b…) — the consultable, citable, ingestable form — so THAT is
    // what becomes the corpus member. Notices without a digitization, and every
    // non-catalogue ARK, pass through untouched. This must run here (not in the
    // background resolver) because it changes the membership key, and corpus
    // versions are immutable once sealed. Strictly best-effort and time-boxed:
    // a slow/down data.bnf.fr just leaves notices as-is rather than stalling the
    // add (only `cb…` ARKs incur any network — Gallica adds skip it entirely).
    let arks = input.arks
    // Notices that stayed notices, and WHY — so we can later offer a manual
    // "promote" only when a retry might help (api_error) vs state the notice
    // simply isn't on Gallica (not_digitized). Persisted after stubs exist.
    const canonicalStatusByArk = new Map<string, DocumentCanonicalStatus>()
    if (opts?.canonicalize) {
      const client = new BnfDirectClient({
        signal: AbortSignal.timeout(BNF_CANONICALIZE_BUDGET_MS),
      })
      const outcomes = await client.canonicalizeArks(input.arks)
      const upgrade = new Map<string, string>()
      for (const o of outcomes) {
        if (o.status === "upgraded") upgrade.set(o.ark, o.canonical)
        else canonicalStatusByArk.set(o.ark, o.status)
      }
      if (upgrade.size > 0) arks = input.arks.map((a) => upgrade.get(a) ?? a)
    }

    // Dedupe the (canonicalized) ARKs up front: the caller is encouraged to fire
    // every ARK it found without cross-referencing the corpus itself, so the
    // same ARK may appear twice — and a notice plus its own digitization now
    // collapse to one. Deduping here also prevents a duplicate (versionId, ark)
    // PK violation in advanceVersion's createMany.
    const uniqueArks = [...new Set(arks)]

    // === Phase 1: create stub rows for unknown ARKs (no lock, no network) =====
    // Idempotent: ARKs that already have a row (stub or resolved) are untouched.
    // Returns the ARKs newly inserted as pending stubs.
    const newStubArks = await DocumentService.createStubs(projectId, uniqueArks)
    const newStubSet = new Set(newStubArks)

    // Record the canonicalization outcome on the notices that stayed notices
    // (every one now has a Document row from createStubs). Grouped per status so
    // it is at most two updateMany calls regardless of batch size.
    if (canonicalStatusByArk.size > 0) {
      const arksByStatus = new Map<DocumentCanonicalStatus, string[]>()
      for (const [ark, status] of canonicalStatusByArk) {
        const list = arksByStatus.get(status) ?? []
        list.push(ark)
        arksByStatus.set(status, list)
      }
      for (const [status, statusArks] of arksByStatus) {
        await prisma.document.updateMany({
          where: { projectId, ark: { in: statusArks } },
          data: { canonicalStatus: status },
        })
      }
    }

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

    // --- Record session attribution (optional) --------------------------------
    // Tag every supplied (deduped) ARK with the contributing session — including
    // ARKs that were already corpus members, so a document re-added from another
    // session shows under both. The composite PK (projectId, ark, sessionId)
    // dedupes same-session re-adds via skipDuplicates. Every uniqueArk has a
    // Document row by now (createStubs ran above), so the FK holds. Contributions
    // are a separate concern from membership/versions — recorded outside the
    // version-advance tx, after commit.
    if (sessionId !== undefined) {
      await prisma.corpusContribution.createMany({
        data: uniqueArks.map((ark) => ({ projectId, ark, sessionId })),
        skipDuplicates: true,
      })
    }

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
   * Promote a catalogue notice (`cb…`) to its digitized Gallica document on
   * demand — the manual counterpart to the add-time canonicalization, for when
   * the add-time pass failed transiently (the BnF API was flaky).
   *
   * Re-runs the cb→Gallica classification for the single ARK and:
   *   - upgraded      → swaps membership (remove the notice, add the digitized
   *                     ARK) in ONE new version, stubs the digitized doc for the
   *                     background resolver, and clears the notice's status.
   *   - not_digitized → records it (the panel then states it isn't on Gallica).
   *   - api_error     → records it (the panel keeps offering a retry).
   *
   * Idempotent under concurrency: the membership swap runs inside the per-project
   * advisory lock, like every other version advance.
   */
  static async promoteNotice(
    project: Project,
    user: User,
    ark: string,
  ): Promise<CorpusPromoteResult> {
    const projectId = project.id

    if (sourceFromArk(ark) !== "catalogue") {
      return { promoted: false, status: "not_catalogue" }
    }

    const client = new BnfDirectClient({
      signal: AbortSignal.timeout(BNF_CANONICALIZE_BUDGET_MS),
    })
    const [outcome] = await client.canonicalizeArks([ark])

    // Did not upgrade — persist the (latest) reason so the panel reflects it.
    if (!outcome || outcome.status !== "upgraded") {
      const status =
        outcome?.status === "not_digitized"
          ? DOCUMENT_CANONICAL_STATUS.NOT_DIGITIZED
          : DOCUMENT_CANONICAL_STATUS.API_ERROR
      await prisma.document.update({
        where: { projectId_ark: { projectId, ark } },
        data: { canonicalStatus: status },
      })
      return { promoted: false, status }
    }

    const canonical = outcome.canonical

    // Ensure the digitized doc has a row so the membership FK holds, then swap
    // membership (drop the notice, add the digitized doc) in one new version.
    const newStubArks = await DocumentService.createStubs(projectId, [canonical])

    const advance = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`project:${projectId}`}))`

      const head = await CorpusQueries.headVersion(projectId)
      const memberSet = new Set(head.membership.map((m) => m.ark))

      const newVersion = await advanceVersion(tx, projectId, head, {
        addArks: memberSet.has(canonical) ? [] : [canonical],
        removeArks: memberSet.has(ark) ? [ark] : [],
        createdBy: `user:${user.id}`,
        note: `Promotion : notice ${ark} → document numérisé ${canonical}`,
      })

      const total = await tx.corpusMembership.count({
        where: { versionId: newVersion.id },
      })
      return { versionSeq: newVersion.seq, total }
    })

    // The notice is no longer a member; clear its stale status to keep the row tidy.
    await prisma.document.update({
      where: { projectId_ark: { projectId, ark } },
      data: { canonicalStatus: null },
    })

    return {
      promoted: true,
      status: "upgraded",
      canonical,
      versionSeq: advance.versionSeq,
      total: advance.total,
      pendingResolve: newStubArks.includes(canonical),
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
