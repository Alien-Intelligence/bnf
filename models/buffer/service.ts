import "server-only"
import type { Project, User } from "@/lib/generated/prisma/client"
import { prisma } from "@/lib/db"
import { CorpusService, type CorpusAddResult } from "@/models/corpus/service"
import { BUFFER_STATUS } from "./schema"
import { BufferQueries } from "./queries"
import type { BufferCandidateInput, BufferFilters } from "./types"
import { CORPUS_REMOVE_PREVIEW_LIMIT } from "@/lib/constants"

/**
 * Result of registerCandidates() — how many candidate rows were newly created
 * vs. refreshed, and the resulting candidate total (post-write). Search tools
 * report `added` + `total` so the agent can narrate "42 nouveaux candidats
 * (312 au total dans le tampon)".
 */
export type BufferRegisterResult = {
  /** Supplied hits (before dedupe). */
  requested: number
  /** Newly inserted candidate rows. */
  added: number
  /** Existing rows whose metadata was refreshed (already in the buffer). */
  refreshed: number
  /** Candidate count in the buffer after this write. */
  total: number
}

/**
 * Result of removeByFilter(). Mirrors CorpusRemoveByFilterResult:
 *   - "empty_filter" — the filter set was empty (would match every candidate).
 *                      Refused without mutating; the agent must narrow it.
 *   - "dry_run"      — preview only: `matched` candidates would be removed;
 *                      `arks` is a capped sample, `matched` is the true count.
 *   - "removed"      — the removal committed: matching candidates are discarded.
 */
export type BufferRemoveByFilterResult =
  | { status: "empty_filter" }
  | { status: "dry_run"; matched: number; arks: string[] }
  | { status: "removed"; matched: number; removed: number }

/**
 * Result of commit() — the candidate set moved into the versioned corpus.
 * `corpus` carries the underlying CorpusAddResult (version, total, pending…).
 */
export type BufferCommitResult = {
  /** Candidate ARKs submitted to the corpus. */
  committed: number
  /** ARKs already present in the corpus (skipped by addArks dedupe). */
  duplicates: number
  corpus: CorpusAddResult
}

export class BufferService {
  /**
   * Upsert search hits as CANDIDATE rows, deduped by [projectId, ark]. Status
   * is never downgraded: a row already `committed` (in the corpus) or
   * `discarded` (dropped by the user) keeps its status and only refreshes its
   * metadata — a search must not resurrect a deliberately-dropped or
   * already-committed ARK back into the candidate set.
   */
  static async registerCandidates(args: {
    projectId: string
    sessionId?: string | null
    originTool: string
    originQuery?: string | null
    candidates: BufferCandidateInput[]
  }): Promise<BufferRegisterResult> {
    // Dedupe the incoming batch by ARK (last write wins) before touching the DB.
    const byArk = new Map<string, BufferCandidateInput>()
    for (const c of args.candidates) byArk.set(c.ark, c)
    const unique = [...byArk.values()]

    let added = 0
    let refreshed = 0
    for (const c of unique) {
      const metadata = {
        title: c.title ?? null,
        year: c.year ?? null,
        docType: c.docType ?? null,
        lang: c.lang ?? null,
        source: c.source ?? null,
        snippet: c.snippet ?? null,
      }
      const result = await prisma.bufferItem.upsert({
        where: { projectId_ark: { projectId: args.projectId, ark: c.ark } },
        create: {
          projectId: args.projectId,
          ark: c.ark,
          ...metadata,
          originTool: args.originTool,
          originQuery: args.originQuery ?? null,
          addedBySessionId: args.sessionId ?? null,
          status: BUFFER_STATUS.CANDIDATE,
        },
        // Refresh only fields that carry a value — never null-out prior metadata,
        // never touch `status` (no resurrection). Fields left undefined below are
        // untouched by Prisma.
        update: {
          ...(c.title !== undefined ? { title: c.title } : {}),
          ...(c.year !== undefined ? { year: c.year } : {}),
          ...(c.docType !== undefined ? { docType: c.docType } : {}),
          ...(c.lang !== undefined ? { lang: c.lang } : {}),
          ...(c.source !== undefined ? { source: c.source } : {}),
          ...(c.snippet !== undefined ? { snippet: c.snippet } : {}),
        },
        select: { createdAt: true, updatedAt: true },
      })
      // A fresh insert has createdAt === updatedAt; an update advances updatedAt.
      if (result.createdAt.getTime() === result.updatedAt.getTime()) added += 1
      else refreshed += 1
    }

    const total = await BufferQueries.count(args.projectId)
    return { requested: args.candidates.length, added, refreshed, total }
  }

  /** Mark candidates as `discarded` by ARK. Returns how many were dropped. */
  static async discard(projectId: string, arks: string[]): Promise<number> {
    if (arks.length === 0) return 0
    const result = await prisma.bufferItem.updateMany({
      where: { projectId, ark: { in: arks }, status: BUFFER_STATUS.CANDIDATE },
      data: { status: BUFFER_STATUS.DISCARDED },
    })
    return result.count
  }

  /**
   * Remove candidates that MATCH the filter — same semantics as
   * corpus_remove_by_filter (remove matches, dry-run first). An empty filter is
   * refused so the agent cannot wipe the whole buffer by accident (use clear()
   * for that, explicitly).
   */
  static async removeByFilter(
    projectId: string,
    input: { filters: BufferFilters; dryRun: boolean },
  ): Promise<BufferRemoveByFilterResult> {
    if (!BufferService.hasConstraint(input.filters)) return { status: "empty_filter" }

    const arks = await BufferQueries.candidateArks(projectId, input.filters)

    if (input.dryRun) {
      return {
        status: "dry_run",
        matched: arks.length,
        arks: arks.slice(0, CORPUS_REMOVE_PREVIEW_LIMIT),
      }
    }

    const removed = await BufferService.discard(projectId, arks)
    return { status: "removed", matched: arks.length, removed }
  }

  /**
   * Commit the buffer's candidates into the versioned corpus via
   * CorpusService.addArks (the sole path that advances a version). Committed
   * rows are marked `committed` (kept for provenance). Returns the underlying
   * CorpusAddResult so the tool can report the new version + pending stubs.
   *
   * `sessionId` threads CorpusContribution attribution through addArks.
   */
  static async commit(
    project: Project,
    user: User,
    args: { sessionId?: string | null; reason: string },
  ): Promise<BufferCommitResult> {
    const arks = await BufferQueries.candidateArks(project.id)
    if (arks.length === 0) {
      // Nothing to commit — reflect the corpus as-is without advancing a version.
      const snapshot = await CorpusService.addArks(
        project,
        user,
        { arks: [], reason: args.reason },
        args.sessionId ?? undefined,
      )
      return { committed: 0, duplicates: 0, corpus: snapshot }
    }

    const corpus = await CorpusService.addArks(
      project,
      user,
      { arks, reason: args.reason },
      args.sessionId ?? undefined,
      { canonicalize: true },
    )

    await prisma.bufferItem.updateMany({
      where: { projectId: project.id, ark: { in: arks }, status: BUFFER_STATUS.CANDIDATE },
      data: { status: BUFFER_STATUS.COMMITTED },
    })

    return { committed: arks.length, duplicates: corpus.duplicates, corpus }
  }

  /**
   * Clear the active buffer for a fresh line of inquiry — drops CANDIDATE and
   * DISCARDED rows, preserving `committed` provenance. Returns how many rows
   * were removed.
   */
  static async clear(projectId: string): Promise<number> {
    const result = await prisma.bufferItem.deleteMany({
      where: {
        projectId,
        status: { in: [BUFFER_STATUS.CANDIDATE, BUFFER_STATUS.DISCARDED] },
      },
    })
    return result.count
  }

  /** True when at least one filter field carries a constraint. */
  private static hasConstraint(filters: BufferFilters): boolean {
    return !!(
      filters.type ||
      filters.lang ||
      filters.source ||
      filters.yearFrom !== undefined ||
      filters.yearTo !== undefined ||
      filters.undated === true ||
      filters.q
    )
  }
}
