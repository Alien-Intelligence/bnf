import "server-only"
import type { Prisma, Project, User } from "@/lib/generated/prisma/client"
import { prisma } from "@/lib/db"
import { CorpusQueries } from "@/models/corpus/queries"
import { CorpusService, type CorpusAddResult } from "@/models/corpus/service"
import { BUFFER_ENRICH_STATUS, BUFFER_STATUS } from "./schema"
import { BufferQueries, bufferFieldClauses, type BufferFilterSet } from "./queries"
import { arkSchema, type BufferCandidateInput } from "./types"
import { BUFFER_CLASSIFIER_VERSION, CORPUS_REMOVE_PREVIEW_LIMIT } from "@/lib/constants"
import { sourceFromArk } from "@/lib/mcp/vocab"
import { classifyArkKind } from "@/models/documents/schema"

/**
 * Result of registerCandidates() — what became of every hit, so a staging tool
 * can always say WHY `added` is below what the search found (Track E Phase 6:
 * session (b) read `added: 0, refreshed: 50, buffered: 0` as a malfunction and
 * looped for ten minutes). For the valid, deduped hits:
 * added + refreshed + alreadyInCorpus + previouslyDiscarded = the batch.
 */
export type BufferRegisterResult = {
  /** Hits supplied (before dedupe). */
  requested: number
  /** Rows that became candidates in this call (new + restaged). */
  added: number
  /** Of `added`: were `committed` but are no longer in the corpus. */
  restaged: number
  /** Already candidates; metadata refreshed. */
  refreshed: number
  /** In the head corpus version — not staged (kept as committed provenance). */
  alreadyInCorpus: number
  /** Dropped earlier — not resurrected by a search. */
  previouslyDiscarded: number
  /** Not valid document ARKs (e.g. `cb…/date` before mapping). Never staged. */
  skipped: number
  /** Of the candidates touched: still without metadata (enrichStatus pending). */
  unresolved: number
  /** Candidate count after the write. */
  total: number
}

/** "1 nouveau candidat", "3 nouveaux candidats" — French uses the singular for 0 and 1. */
function plural(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n <= 1 ? singular : pluralForm}`
}

/**
 * Plain French for a staging result whose `added` is below what the search
 * found, or null when every hit became a candidate. Returned to the agent as
 * `explanation`, so a zero is never read as a malfunction to retry around.
 */
export function explainRegistration(found: number, r: BufferRegisterResult): string | null {
  if (r.added === found) return null
  const head =
    plural(r.added, "nouveau candidat", "nouveaux candidats") +
    (r.restaged > 0
      ? ` (dont ${r.restaged} ${r.restaged <= 1 ? "retiré" : "retirés"} du corpus depuis, de nouveau candidats)`
      : "")
  const parts: string[] = []
  if (r.alreadyInCorpus > 0) {
    parts.push(
      r.alreadyInCorpus <= 1
        ? `${r.alreadyInCorpus} est déjà dans le corpus (validé plus tôt)`
        : `${r.alreadyInCorpus} sont déjà dans le corpus (validés plus tôt)`,
    )
  }
  if (r.refreshed > 0) {
    parts.push(`${r.refreshed} ${r.refreshed <= 1 ? "était" : "étaient"} déjà dans le tampon (métadonnées mises à jour)`)
  }
  if (r.previouslyDiscarded > 0) {
    parts.push(
      r.previouslyDiscarded <= 1
        ? `${r.previouslyDiscarded} a été écarté plus tôt, non réintroduit`
        : `${r.previouslyDiscarded} ont été écartés plus tôt, non réintroduits`,
    )
  }
  if (r.skipped > 0) {
    parts.push(`${r.skipped} ${r.skipped <= 1 ? "n'est" : "ne sont"} pas un document (entrée de collection)`)
  }
  const detail = parts.length > 0 ? `, ${parts.join(", ")}` : ""
  const tail =
    r.added === 0
      ? ` — ${r.refreshed === 0 ? "rien à trier, " : ""}ce n'est pas une panne. ` +
        "Inutile de vider le tampon ou de relancer cette recherche."
      : "."
  return `${head} : sur ${plural(found, "résultat", "résultats")}${detail}${tail}`
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
  | {
      status: "dry_run"
      matched: number
      arks: string[]
      /** With `not`: per excluded dimension, candidates of UNKNOWN value that
       *  the exclusion deliberately left alone (Decision 4). */
      notUnknown?: Record<string, number>
    }
  | { status: "removed"; matched: number; removed: number }

/**
 * Result of commit() — the candidate set moved into the versioned corpus.
 * `corpus` carries the underlying CorpusAddResult (version, total, pending…).
 */
export type BufferCommitResult = {
  /** Candidate ARKs submitted to the corpus. */
  committed: number
  /** Of those, catalogue notices (`cb…`) — queued for cb→Gallica
   *  canonicalisation, so the caller knows whether to kick that drain. */
  catalogueNotices: number
  /** ARKs already present in the corpus (skipped by addArks dedupe). */
  duplicates: number
  /** Head members still waiting for cb→Gallica canonicalisation AFTER the
   *  commit: while above zero, `corpus.total` will still change. */
  canonicalizationPending: number
  /** Committed candidates whose metadata was still being resolved. */
  committedUnresolved: number
  corpus: CorpusAddResult
}

/** The columns registerCandidates reads back for an existing row. */
const existingRowSelect = {
  ark: true,
  status: true,
  title: true,
  enrichStatus: true,
} satisfies Prisma.BufferItemSelect
type ExistingRow = Prisma.BufferItemGetPayload<{ select: typeof existingRowSelect }>

/** Enrichment states a hit carrying a title settles. */
const UNSETTLED_ENRICH: ReadonlySet<string | null> = new Set([
  BUFFER_ENRICH_STATUS.PENDING,
  BUFFER_ENRICH_STATUS.FAILED,
])

/**
 * The row a never-seen hit becomes. `docType` is canonical; the kind is the
 * producer's when it knows more than (ark, docType) — a `cb…/date` collection
 * entry — and derived otherwise. A bare candidate (no title) is queued for the
 * background enrichment drain. Every row written here is in the current
 * classification, so the boot reclassifier never re-reads it.
 */
function insertData(
  args: { projectId: string; sessionId?: string | null; originTool: string; originQuery?: string | null },
  c: BufferCandidateInput,
  status: string,
): Prisma.BufferItemCreateManyInput {
  return {
    projectId: args.projectId,
    ark: c.ark,
    title: c.title ?? null,
    year: c.year ?? null,
    docType: c.docType ?? null,
    docTypeRaw: c.docTypeRaw ?? null,
    arkKind: c.arkKind ?? classifyArkKind({ ark: c.ark, collectionEntry: false, docType: c.docType ?? null }),
    lang: c.lang ?? null,
    source: c.source ?? null,
    snippet: c.snippet ?? null,
    creator: c.creator ?? null,
    publisher: c.publisher ?? null,
    dateLabel: c.dateLabel ?? null,
    yearEnd: c.yearEnd ?? null,
    subjects: c.subjects ?? null,
    gallicaUrl: c.gallicaUrl ?? null,
    catalogueUrl: c.catalogueUrl ?? null,
    searchCollapsing: c.searchCollapsing ?? null,
    classifierVersion: BUFFER_CLASSIFIER_VERSION,
    originTool: args.originTool,
    originQuery: args.originQuery ?? null,
    addedBySessionId: args.sessionId ?? null,
    status,
    enrichStatus:
      status === BUFFER_STATUS.CANDIDATE && c.title === undefined ? BUFFER_ENRICH_STATUS.PENDING : null,
  }
}

/**
 * The metadata refresh for an existing row: only fields that carry a value
 * (never null-out prior metadata, never touch `status` here). A hit that
 * carries a type rewrites the row's classification as a whole and stamps the
 * version; a hit without one (a catalogue record) never downgrades a kind a
 * typed hit established. A title settles a pending/failed enrichment.
 */
function refreshData(c: BufferCandidateInput, row: ExistingRow): Prisma.BufferItemUpdateInput {
  return {
    ...(c.title !== undefined ? { title: c.title } : {}),
    ...(c.year !== undefined ? { year: c.year } : {}),
    ...(c.docType !== undefined
      ? {
          docType: c.docType,
          docTypeRaw: c.docTypeRaw ?? null,
          arkKind: c.arkKind ?? classifyArkKind({ ark: c.ark, collectionEntry: false, docType: c.docType }),
          classifierVersion: BUFFER_CLASSIFIER_VERSION,
        }
      : c.arkKind !== undefined
        ? { arkKind: c.arkKind }
        : {}),
    ...(c.lang !== undefined ? { lang: c.lang } : {}),
    ...(c.source !== undefined ? { source: c.source } : {}),
    ...(c.snippet !== undefined ? { snippet: c.snippet } : {}),
    ...(c.creator !== undefined ? { creator: c.creator } : {}),
    ...(c.publisher !== undefined ? { publisher: c.publisher } : {}),
    // A new date label rewrites the range as a whole: a single-year label
    // clears a stale end year rather than leaving a range it no longer has.
    ...(c.dateLabel !== undefined ? { dateLabel: c.dateLabel, yearEnd: c.yearEnd ?? null } : {}),
    ...(c.subjects !== undefined ? { subjects: c.subjects } : {}),
    ...(c.gallicaUrl !== undefined ? { gallicaUrl: c.gallicaUrl } : {}),
    ...(c.catalogueUrl !== undefined ? { catalogueUrl: c.catalogueUrl } : {}),
    ...(c.searchCollapsing !== undefined ? { searchCollapsing: c.searchCollapsing } : {}),
    ...(c.title !== undefined && UNSETTLED_ENRICH.has(row.enrichStatus)
      ? { enrichStatus: BUFFER_ENRICH_STATUS.RESOLVED, enrichError: null }
      : {}),
  }
}

export class BufferService {
  /**
   * Stage search hits, deduped by [projectId, ark]. The candidate set is
   * found ∖ head corpus ∖ discarded (Decision 9 of the Track E plan):
   *   - in the head corpus           → kept/marked `committed`, counted in `alreadyInCorpus`
   *   - `committed` but no longer in head (removed since) → `candidate` again, `restaged`
   *   - `discarded`, re-found by a search → stays `discarded`, `previouslyDiscarded`
   *   - `discarded`, named by an explicit buffer_add (`restageDiscarded`) → `candidate`
   *   - already a candidate          → metadata refreshed, `refreshed`
   *
   * `added` is race-safe: new rows go through createManyAndReturn with
   * skipDuplicates, which returns exactly the rows THIS call inserted, and
   * every status transition is a guarded updateMany whose count is what is
   * reported — so two sub-agents staging overlapping pages never count one ARK
   * twice.
   */
  static async registerCandidates(args: {
    projectId: string
    sessionId?: string | null
    originTool: string
    originQuery?: string | null
    /** True only for an explicit buffer_add: the librarian named these ARKs,
     *  so a discarded one is staged again. A search never does. No default —
     *  each call site decides. */
    restageDiscarded: boolean
    candidates: BufferCandidateInput[]
  }): Promise<BufferRegisterResult> {
    // Reject anything that is not a valid ARK BEFORE it can be staged. The
    // buffer feeds CorpusService.addArks, and the tool path does not re-run the
    // route-level Zod schema — so this is the structural guarantee that a
    // malformed identifier (e.g. the `cb…/date` periodical-collection form the
    // BnF SRU returns) can never reach Document / corpus_membership.
    const valid = args.candidates.filter((c) => arkSchema.safeParse(c.ark).success)
    const skipped = args.candidates.length - valid.length

    // Dedupe the incoming batch by ARK (last write wins) before touching the DB.
    const byArk = new Map<string, BufferCandidateInput>()
    for (const c of valid) byArk.set(c.ark, c)
    const unique = [...byArk.values()]
    const arks = unique.map((c) => c.ark)

    const inCorpus = await CorpusQueries.headMembersAmong(args.projectId, arks)
    const existing = new Map<string, ExistingRow>(
      (
        await prisma.bufferItem.findMany({
          where: { projectId: args.projectId, ark: { in: arks } },
          select: existingRowSelect,
        })
      ).map((r) => [r.ark, r]),
    )

    // 1. ARKs the buffer has never seen.
    const fresh = unique.filter((c) => !existing.has(c.ark))
    const inserted =
      fresh.length === 0
        ? []
        : await prisma.bufferItem.createManyAndReturn({
            data: fresh.map((c) =>
              insertData(args, c, inCorpus.has(c.ark) ? BUFFER_STATUS.COMMITTED : BUFFER_STATUS.CANDIDATE),
            ),
            skipDuplicates: true,
            select: { ark: true, status: true },
          })
    const insertedArks = new Set(inserted.map((r) => r.ark))
    // A row a parallel call inserted between our read and our insert is not
    // ours: it is handled below like any existing row.
    const raced = fresh.filter((c) => !insertedArks.has(c.ark)).map((c) => c.ark)
    if (raced.length > 0) {
      const rows = await prisma.bufferItem.findMany({
        where: { projectId: args.projectId, ark: { in: raced } },
        select: existingRowSelect,
      })
      for (const r of rows) existing.set(r.ark, r)
    }

    // 2. Existing rows: refresh metadata, then decide the status transition.
    const refreshes: Prisma.PrismaPromise<unknown>[] = []
    const toCommitted: string[] = []
    const toRestage: string[] = []
    const toUndiscard: string[] = []
    let refreshed = 0
    let previouslyDiscarded = 0
    for (const c of unique) {
      if (insertedArks.has(c.ark)) continue
      const row = existing.get(c.ark)
      if (row === undefined) continue // deleted (buffer_clear) between our reads — nothing to stage onto
      const data = refreshData(c, row)
      if (Object.keys(data).length > 0) {
        refreshes.push(
          prisma.bufferItem.update({
            where: { projectId_ark: { projectId: args.projectId, ark: c.ark } },
            data,
          }),
        )
      }
      if (inCorpus.has(c.ark)) {
        if (row.status !== BUFFER_STATUS.COMMITTED) toCommitted.push(c.ark)
      } else if (row.status === BUFFER_STATUS.COMMITTED) {
        toRestage.push(c.ark)
      } else if (row.status === BUFFER_STATUS.DISCARDED) {
        if (args.restageDiscarded) toUndiscard.push(c.ark)
        else previouslyDiscarded += 1
      } else {
        refreshed += 1
      }
    }

    const where = (list: string[], status: string): Prisma.BufferItemWhereInput => ({
      projectId: args.projectId,
      ark: { in: list },
      status,
    })
    const results = await prisma.$transaction([
      ...refreshes,
      prisma.bufferItem.updateMany({
        where: { projectId: args.projectId, ark: { in: toCommitted }, status: { not: BUFFER_STATUS.COMMITTED } },
        data: { status: BUFFER_STATUS.COMMITTED },
      }),
      prisma.bufferItem.updateMany({
        where: where(toRestage, BUFFER_STATUS.COMMITTED),
        data: { status: BUFFER_STATUS.CANDIDATE },
      }),
      prisma.bufferItem.updateMany({
        where: where(toUndiscard, BUFFER_STATUS.DISCARDED),
        data: { status: BUFFER_STATUS.CANDIDATE },
      }),
      // A bare row that just became a candidate again is curated again: queue
      // it for enrichment (never re-queues a row the drain gave up on).
      prisma.bufferItem.updateMany({
        where: {
          projectId: args.projectId,
          ark: { in: [...toRestage, ...toUndiscard] },
          status: BUFFER_STATUS.CANDIDATE,
          title: null,
          enrichStatus: null,
        },
        data: { enrichStatus: BUFFER_ENRICH_STATUS.PENDING },
      }),
    ])
    const transitionCount = (offset: number): number => {
      const r = results[refreshes.length + offset]
      if (typeof r !== "object" || r === null || !("count" in r) || typeof r.count !== "number") {
        throw new Error(`registerCandidates: transition ${offset} returned no count`)
      }
      return r.count
    }
    const restaged = transitionCount(1)
    const undiscarded = transitionCount(2)

    const insertedCandidates = inserted.filter((r) => r.status === BUFFER_STATUS.CANDIDATE).length
    const [unresolved, total] = await Promise.all([
      prisma.bufferItem.count({
        where: {
          projectId: args.projectId,
          ark: { in: arks },
          status: BUFFER_STATUS.CANDIDATE,
          enrichStatus: BUFFER_ENRICH_STATUS.PENDING,
        },
      }),
      BufferQueries.count(args.projectId),
    ])

    return {
      requested: args.candidates.length,
      added: insertedCandidates + restaged + undiscarded,
      restaged,
      refreshed,
      alreadyInCorpus: arks.filter((a) => inCorpus.has(a)).length,
      previouslyDiscarded,
      skipped,
      unresolved,
      total,
    }
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
    input: { filters: BufferFilterSet; dryRun: boolean },
  ): Promise<BufferRemoveByFilterResult> {
    if (!BufferService.hasConstraint(input.filters)) return { status: "empty_filter" }

    const arks = await BufferQueries.candidateArks(projectId, input.filters)

    if (input.dryRun) {
      const notUnknown =
        input.filters.not !== undefined ? await BufferQueries.notUnknownCounts(projectId, input.filters) : null
      return {
        status: "dry_run",
        matched: arks.length,
        arks: arks.slice(0, CORPUS_REMOVE_PREVIEW_LIMIT),
        ...(notUnknown !== null ? { notUnknown } : {}),
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
    // Belt and braces: registerCandidates already refuses malformed ARKs, but a
    // row staged before that guard existed must never poison a corpus version —
    // the service layer below does NOT re-run the route's Zod schema.
    const staged = await BufferQueries.candidateArks(project.id)
    const arks = staged.filter((a) => arkSchema.safeParse(a).success)
    if (arks.length === 0) {
      // Nothing to commit — reflect the corpus as-is without advancing a version.
      const snapshot = await CorpusService.addArks(
        project,
        user,
        { arks: [], reason: args.reason },
        args.sessionId ?? undefined,
      )
      return {
        committed: 0,
        catalogueNotices: 0,
        duplicates: 0,
        canonicalizationPending: await CorpusQueries.pendingCanonicalCount(project.id),
        committedUnresolved: 0,
        corpus: snapshot,
      }
    }

    // Counted before the rows leave the candidate set: their metadata was
    // still being resolved, which the agent reports rather than hides.
    const committedUnresolved = await prisma.bufferItem.count({
      where: {
        projectId: project.id,
        ark: { in: arks },
        status: BUFFER_STATUS.CANDIDATE,
        enrichStatus: BUFFER_ENRICH_STATUS.PENDING,
      },
    })

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

    return {
      committed: arks.length,
      catalogueNotices: arks.filter((a) => sourceFromArk(a) === "catalogue").length,
      duplicates: corpus.duplicates,
      // After addArks: the notices it just queued count, and so do any still
      // pending from earlier. While this is above zero the background
      // canonicaliser will replace notices by their digitized documents and
      // merge duplicates — `corpus.total` is not final (Village suisse: the
      // commit said 58, the head held 44 thirty seconds later).
      canonicalizationPending: await CorpusQueries.pendingCanonicalCount(project.id),
      committedUnresolved,
      corpus,
    }
  }

  /**
   * Clear the active buffer for a fresh line of inquiry. Returns how many rows
   * were removed. The rule (Decision 10):
   *   - it drops candidates and discarded rows;
   *   - committed rows remain as provenance;
   *   - a later search reports a committed ARK in `alreadyInCorpus` while it is
   *     in the corpus, and restages it once it leaves the corpus
   *     (registerCandidates) — so clearing never makes `added` go up for
   *     documents already in the corpus.
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

  /** True when at least one filter field carries a constraint — a non-empty
   *  `not` counts ("remove everything not French" is a real constraint). */
  private static hasConstraint(filters: BufferFilterSet): boolean {
    const { not, ...positive } = filters
    return bufferFieldClauses(positive).length > 0 || (not !== undefined && bufferFieldClauses(not).length > 0)
  }
}
