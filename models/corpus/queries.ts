// models/corpus/queries.ts
// Pure database access for the corpus model. No business logic, no external
// calls, no transforms beyond what Prisma returns.
// Imports only from @/lib/db and ./schema.
import "server-only"

import { prisma } from "@/lib/db"
import type { Prisma } from "@/lib/generated/prisma/client"
import { CORPUS_SAMPLE_SIZE } from "@/lib/constants"
import {
  DOCUMENT_RESOLVE_STATUS,
  INGESTION_CLASS,
  INGESTION_IMAGE_LIKE_TYPES,
  classifyIngestion,
} from "@/models/documents/schema"

// Prisma WHERE fragment matching one ingestion class — the SQL mirror of
// classifyIngestion(). digitized ⇔ iiifManifestUrl is set (Gallica-only);
// "no OCR" is false OR null (unknown counts as none, as in the classifier).
// Returns null for an unrecognised class so callers can filter it out.
function ingestClassWhere(cls: string): Prisma.DocumentWhereInput | null {
  const imageLike = [...INGESTION_IMAGE_LIKE_TYPES]
  const noOcr: Prisma.DocumentWhereInput["OR"] = [
    { ocrAvailable: false },
    { ocrAvailable: null },
  ]
  switch (cls) {
    case INGESTION_CLASS.OCR:
      return { iiifManifestUrl: { not: null }, ocrAvailable: true }
    case INGESTION_CLASS.VISION:
      return { iiifManifestUrl: { not: null }, docType: { in: imageLike }, OR: noOcr }
    case INGESTION_CLASS.SANS_TEXTE:
      return { iiifManifestUrl: { not: null }, docType: { notIn: imageLike }, OR: noOcr }
    case INGESTION_CLASS.NON_NUMERISE:
      return { iiifManifestUrl: null }
    default:
      return null
  }
}
import {
  corpusVersionWithArks,
  documentRow,
  type CorpusCrossFacets,
  type CorpusDiff,
  type CorpusFacetDimension,
  type CorpusListPage,
  type CorpusSnapshot,
  type CorpusVersionStatus,
  type CorpusVersionWithArks,
} from "./schema"

/**
 * The structured filter set shared by every corpus read path (snapshot, list,
 * crossFacets) and by remove-by-filter. Mirrors the query params of
 * `GET /api/projects/:id/corpus` and the agent-tool filter schema. Multi-select
 * dimensions arrive pre-split into arrays (the route splits the CSV form).
 */
export type CorpusFilterSet = {
  type?: string[]
  lang?: string[]
  source?: string[]
  /** AppSession ids — keep only docs contributed by one of these sessions. */
  session?: string[]
  /** Ingestion classes: ocr | vision | sans_texte | non_numerise. */
  ingest?: string[]
  yearFrom?: number
  yearTo?: number
  undated?: boolean
  q?: string
}

/**
 * Translate a CorpusFilterSet into the two Prisma WHERE predicates every corpus
 * read shares:
 *   - `sharedWhere`   — version membership AND all active filter clauses. Spans
 *                       all members (including pending/failed stubs) except
 *                       where a type/lang/year/q filter naturally excludes them.
 *   - `resolvedWhere` — `sharedWhere` further constrained to RESOLVED documents.
 *                       Used for the type/lang/period facets and the period
 *                       histogram, which are meaningless for unresolved stubs.
 *
 * Extracted from `snapshot()` so `list()`, `crossFacets()`, and
 * `removeByFilter()` resolve membership identically — there is exactly one
 * filter→SQL translation in the codebase. Pure: no I/O, deterministic in its
 * inputs.
 *
 * Year semantics: a yearFrom/yearTo range wins over `undated`; with neither,
 * `undated === true` matches `year IS NULL`. Full-text and ingest each carry
 * their own `OR`, so they are AND-ed via an explicit `AND` array rather than
 * spread (two `OR` keys at one object level would collide).
 */
function buildCorpusWhere(
  versionId: string,
  filters?: CorpusFilterSet,
): {
  sharedWhere: Prisma.DocumentWhereInput
  resolvedWhere: Prisma.DocumentWhereInput
  /**
   * The individual filter clauses, exposed for the few snapshot counts that
   * apply a deliberately different subset (e.g. `undatedCount` ignores the year
   * range; `pendingCount`/`failedCount` honour only `source`). Keeping these
   * here means the filter→SQL translation lives in exactly one place.
   */
  parts: {
    typeWhere: Prisma.DocumentWhereInput
    langWhere: Prisma.DocumentWhereInput
    sourceWhere: Prisma.DocumentWhereInput
    fullTextWhere: Prisma.DocumentWhereInput
  }
} {
  const hasYearRange =
    filters?.yearFrom !== undefined || filters?.yearTo !== undefined
  const yearWhere: Prisma.DocumentWhereInput = hasYearRange
    ? {
        year: {
          ...(filters?.yearFrom !== undefined ? { gte: filters.yearFrom } : {}),
          ...(filters?.yearTo !== undefined ? { lte: filters.yearTo } : {}),
        },
      }
    : filters?.undated === true
      ? { year: null }
      : {}

  const typeWhere: Prisma.DocumentWhereInput =
    filters?.type && filters.type.length > 0
      ? { docType: { in: filters.type } }
      : {}

  const langWhere: Prisma.DocumentWhereInput =
    filters?.lang && filters.lang.length > 0 ? { lang: { in: filters.lang } } : {}

  const sourceWhere: Prisma.DocumentWhereInput =
    filters?.source && filters.source.length > 0
      ? { source: { in: filters.source } }
      : {}

  // Session filter: keep only documents at least one of the selected sessions
  // contributed. `some` over the CorpusContribution relation gives exactly that.
  const sessionWhere: Prisma.DocumentWhereInput =
    filters?.session && filters.session.length > 0
      ? { contributions: { some: { sessionId: { in: filters.session } } } }
      : {}

  // Full-text: Prisma OR over contains (ILIKE on Postgres, mode-insensitive),
  // matching title, author, and excerpt (null columns are skipped automatically).
  const fullTextWhere: Prisma.DocumentWhereInput =
    filters?.q && filters.q.trim().length > 0
      ? {
          OR: [
            { title: { contains: filters.q, mode: "insensitive" as const } },
            { author: { contains: filters.q, mode: "insensitive" as const } },
            { excerpt: { contains: filters.q, mode: "insensitive" as const } },
          ],
        }
      : {}

  // Ingestion-class filter: an OR over the selected classes, each a SQL mirror
  // of classifyIngestion(). Constrained to resolved rows (the class is unknown
  // for stubs). null when no class is selected.
  const ingestPredicates =
    filters?.ingest && filters.ingest.length > 0
      ? filters.ingest
          .map(ingestClassWhere)
          .filter((w): w is Prisma.DocumentWhereInput => w !== null)
      : []
  const ingestWhere: Prisma.DocumentWhereInput | null =
    ingestPredicates.length > 0
      ? { resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED, OR: ingestPredicates }
      : null

  const andClauses: Prisma.DocumentWhereInput[] = []
  if (filters?.q && filters.q.trim().length > 0) andClauses.push(fullTextWhere)
  if (ingestWhere) andClauses.push(ingestWhere)

  const sharedWhere: Prisma.DocumentWhereInput = {
    membership: { some: { versionId } },
    ...typeWhere,
    ...langWhere,
    ...sourceWhere,
    ...sessionWhere,
    ...yearWhere,
    ...(andClauses.length > 0 ? { AND: andClauses } : {}),
  }

  const resolvedWhere: Prisma.DocumentWhereInput = {
    ...sharedWhere,
    resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
  }

  return {
    sharedWhere,
    resolvedWhere,
    parts: { typeWhere, langWhere, sourceWhere, fullTextWhere },
  }
}

export class CorpusQueries {
  /**
   * Returns the current head version (with membership ARKs) for a project.
   * Looks up via Project.headVersionId so we never scan corpus_version for
   * an isHead flag (there is none — head is identified by the Project pointer
   * only, per playbook/corpus-versioning.md).
   */
  static async headVersion(projectId: string): Promise<CorpusVersionWithArks> {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { headVersionId: true },
    })

    if (!project.headVersionId) {
      throw new Error(
        `Project ${projectId} has no headVersionId — invariant 1 violated`,
      )
    }

    return prisma.corpusVersion.findUniqueOrThrow({
      where: { id: project.headVersionId },
      ...corpusVersionWithArks,
    })
  }

  /**
   * Returns the last successfully ingested version (with membership ARKs), or
   * null if the corpus has never been ingested.
   */
  static async ingestedVersion(
    projectId: string,
  ): Promise<CorpusVersionWithArks | null> {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { ingestedVersionId: true },
    })

    if (!project.ingestedVersionId) {
      return null
    }

    return prisma.corpusVersion.findUniqueOrThrow({
      where: { id: project.ingestedVersionId },
      ...corpusVersionWithArks,
    })
  }

  /**
   * Returns the flat list of ARKs in a corpus version.
   */
  static async membershipArks(versionId: string): Promise<string[]> {
    const rows = await prisma.corpusMembership.findMany({
      where: { versionId },
      select: { ark: true },
    })
    return rows.map((r) => r.ark)
  }

  /**
   * Returns the ARKs currently IN THE INDEX for a project (Document.indexedAt is
   * set). This is the per-document ground truth the ingestion delta is computed
   * against — NOT the coarse ingestedVersionId pointer, which can't express a
   * partial ingest (most docs indexed, one failed). Stamped by
   * IngestService.commit()/commitPartialFailure(). See ingestion-jobs / corpus-versioning.
   */
  static async indexedArks(projectId: string): Promise<string[]> {
    const rows = await prisma.document.findMany({
      where: { projectId, indexedAt: { not: null } },
      select: { ark: true },
    })
    return rows.map((r) => r.ark)
  }

  /**
   * Returns the full corpus comprehension snapshot for a given version ref.
   *
   * `ref`:
   *   - "head"     → Project.headVersionId
   *   - "ingested" → Project.ingestedVersionId (throws if never ingested)
   *   - { seq: N } → looks up by (projectId, seq)
   *
   * `opts.filters` — optional filter set. When supplied, `total`, `facets`,
   * and `sample` all reflect the filtered subset (not the full corpus). This
   * is what makes facet counts shrink under active filters.
   *
   * `opts.cursor` — opaque cursor from a previous response's `nextCursor`.
   * Format: `<versionSeq>:<lastArk>`. Decoded as `WHERE ark > lastArk
   * ORDER BY ark ASC`. Stable for the same version + filters.
   *
   * `opts.limit` — page size, defaults to CORPUS_SAMPLE_SIZE (25).
   *
   * Facets are computed with TWO queries that share the same filter WHERE
   * clause: one `groupBy` per facet dimension (type/lang/source/period), all
   * run in parallel. No separate "unfiltered" query — facets always reflect
   * the current filtered set per the plan §6 spec.
   *
   * Full-text (`opts.filters.q`): Prisma `OR` of case-insensitive `contains`
   * over `title`, `author`, and `excerpt`. Prisma translates `contains` +
   * `mode: "insensitive"` to `ILIKE` on Postgres, which avoids a raw query
   * while staying dependency-free (no pg_trgm) per plan §10.
   *
   * IMPORTANT: always use `total`, never `sample.length`.
   */
  static async snapshot(
    projectId: string,
    ref: "head" | "ingested" | { seq: number },
    opts?: {
      filters?: CorpusFilterSet
      cursor?: string
      limit?: number
    },
  ): Promise<CorpusSnapshot> {
    // --- Resolve the version --------------------------------------------------
    const version = await CorpusQueries.resolveVersion(projectId, ref)
    const versionId = version.id
    const filters = opts?.filters
    const limit = opts?.limit ?? CORPUS_SAMPLE_SIZE

    // --- Build the shared filter WHERE clause --------------------------------
    // All facet queries and the sample query share this exact WHERE predicate
    // so that facets always reflect counts within the active filtered set.
    // `parts` exposes the individual clauses for the few counts below that apply
    // a deliberately different subset (undatedCount ignores the year range;
    // pending/failed honour only source).
    const { sharedWhere, resolvedWhere, parts } = buildCorpusWhere(
      versionId,
      filters,
    )
    const { typeWhere, langWhere, sourceWhere, fullTextWhere } = parts

    // --- Decode cursor -------------------------------------------------------
    // Cursor format: "<versionSeq>:<lastArk>" — we only use lastArk here.
    // versionSeq is included in the cursor so the client can detect a version
    // change (invalidated cursor), but we do not validate it on the server —
    // the Prisma WHERE clause naturally returns an empty page if the ARK is
    // gone, which is safe.
    let cursorArk: string | undefined
    if (opts?.cursor) {
      const colonIdx = opts.cursor.indexOf(":")
      if (colonIdx !== -1) {
        cursorArk = opts.cursor.slice(colonIdx + 1)
      }
    }

    // --- Total filtered count + undated count --------------------------------
    // Run in parallel with facets (below).
    const [
      total,
      undatedCount,
      pendingCount,
      failedCount,
      typeRows,
      langRows,
      sourceRows,
      sessionRows,
      resolvedRows,
    ] = await Promise.all([
      // Total within filtered set (includes pending/failed members when no
      // type/lang/year/q filter excludes them).
      prisma.document.count({ where: sharedWhere }),
      // Undated count: RESOLVED docs with no year (genuinely undated, not
      // merely unresolved). Year filter intentionally not applied so the
      // "Période non datée" tile stays informative under an active year range.
      prisma.document.count({
        where: {
          membership: { some: { versionId } },
          ...typeWhere,
          ...langWhere,
          ...sourceWhere,
          ...fullTextWhere,
          resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
          year: null,
        },
      }),
      // Pending / failed: respect only the source filter (type/lang/year/q
      // cannot describe an unresolved doc). source is derived from the ARK so
      // it is known even for stubs.
      prisma.document.count({
        where: {
          membership: { some: { versionId } },
          ...sourceWhere,
          resolveStatus: DOCUMENT_RESOLVE_STATUS.PENDING,
        },
      }),
      prisma.document.count({
        where: {
          membership: { some: { versionId } },
          ...sourceWhere,
          resolveStatus: DOCUMENT_RESOLVE_STATUS.FAILED,
        },
      }),

      // --- Facets -----------------------------------------------------------
      // type / lang / period reflect RESOLVED docs only. source spans all
      // members (it's ARK-derived, so accurate for pending stubs too).

      // Facet: docType (resolved; docType is non-null once resolved)
      prisma.document.groupBy({
        by: ["docType"],
        where: { ...resolvedWhere, docType: { not: null } },
        _count: { ark: true },
      }),
      // Facet: lang (resolved; skip null lang values)
      prisma.document.groupBy({
        by: ["lang"],
        where: { ...resolvedWhere, lang: { not: null } },
        _count: { ark: true },
      }),
      // Facet: source (all members; skip null source values)
      prisma.document.groupBy({
        by: ["source"],
        where: { ...sharedWhere, source: { not: null } },
        _count: { ark: true },
      }),
      // Facet: session (all members; ARK-derived attribution, accurate for
      // pending stubs too). Grouped over CorpusContribution, scoped via the
      // `document` relation to the current filtered head set (sharedWhere) so the
      // per-session counts shrink under the active filters exactly like the other
      // facets. A document contributed by N sessions counts once under each.
      prisma.corpusContribution.groupBy({
        by: ["sessionId"],
        where: { projectId, document: { ...sharedWhere } },
        _count: { ark: true },
      }),
      // Resolved rows: one pass over the resolved set powers BOTH the period
      // histogram (binned in JS) and the numérisation/ingestion buckets
      // (classified in JS). Cheap for typical set sizes; raw SQL deferred until
      // benchmarks justify it. Dated-only filtering for the histogram happens
      // in the fold below, so this query is not constrained to year != null.
      prisma.document.findMany({
        where: resolvedWhere,
        select: {
          year: true,
          docType: true,
          ocrAvailable: true,
          iiifManifestUrl: true,
        },
      }),
    ])

    // --- Fold facet rows into Record<string, number> -------------------------
    const typeFacet: Record<string, number> = {}
    for (const r of typeRows) {
      // docType is nullable in the schema; resolvedWhere + `not: null` already
      // exclude nulls, but guard for the type-checker.
      if (r.docType !== null) typeFacet[r.docType] = r._count.ark
    }

    const langFacet: Record<string, number> = {}
    for (const r of langRows) {
      if (r.lang !== null) {
        langFacet[r.lang] = r._count.ark
      }
    }

    const sourceFacet: Record<string, number> = {}
    for (const r of sourceRows) {
      if (r.source !== null) {
        sourceFacet[r.source] = r._count.ark
      }
    }

    // Session facet: resolve each contributing session's title (the groupBy only
    // yields ids) and assemble a count-sorted list. Kept a dedicated array — not
    // a Record like the other facets — because each entry carries a title the UI
    // renders as the chip/bar label. Empty when no session has contributed yet
    // (e.g. pre-existing corpora with no contribution rows — not backfilled).
    const sessionCounts = new Map<string, number>()
    for (const r of sessionRows) {
      sessionCounts.set(r.sessionId, r._count.ark)
    }
    const sessionTitles =
      sessionCounts.size > 0
        ? await prisma.appSession.findMany({
            where: { id: { in: [...sessionCounts.keys()] } },
            select: { id: true, title: true },
          })
        : []
    const titleById = new Map(sessionTitles.map((s) => [s.id, s.title]))
    const sessions = [...sessionCounts.entries()]
      .map(([sessionId, count]) => ({
        sessionId,
        title: titleById.get(sessionId) ?? sessionId,
        count,
      }))
      .sort((a, b) => b.count - a.count)

    // Bin years into decade buckets ("1880s", "1890s", …) AND classify each
    // resolved row into a numérisation/ingestion bucket — both from the single
    // resolvedRows pass.
    const periodFacet: Record<string, number> = {}
    const numerisation = {
      resolved: resolvedRows.length,
      digitized: 0,
      ingestable: 0,
      ocr: 0,
      vision: 0,
      sansTexte: 0,
      nonNumerise: 0,
    }
    for (const r of resolvedRows) {
      if (r.year !== null) {
        const decade = Math.floor(r.year / 10) * 10
        const bucket = `${decade}s`
        periodFacet[bucket] = (periodFacet[bucket] ?? 0) + 1
      }

      const cls = classifyIngestion({
        docType: r.docType,
        ocrAvailable: r.ocrAvailable,
        digitized: Boolean(r.iiifManifestUrl),
      })
      switch (cls) {
        case INGESTION_CLASS.OCR:
          numerisation.ocr++
          break
        case INGESTION_CLASS.VISION:
          numerisation.vision++
          break
        case INGESTION_CLASS.SANS_TEXTE:
          numerisation.sansTexte++
          break
        case INGESTION_CLASS.NON_NUMERISE:
          numerisation.nonNumerise++
          break
      }
    }
    numerisation.digitized =
      numerisation.ocr + numerisation.vision + numerisation.sansTexte
    numerisation.ingestable = numerisation.ocr + numerisation.vision

    // NOTE: pending stubs are NOT injected into the facet records — that would
    // corrupt the summary's derived values (period range, type/lang counts).
    // They are surfaced via pendingCount/failedCount, which the UI renders as a
    // dedicated "En cours de résolution" bucket alongside each facet.

    // --- Sample (cursor-paginated) -------------------------------------------
    // ORDER BY ark ASC — alphabetic ARK order is stable and deterministic.
    // Cursor: WHERE ark > lastArk (keyset pagination, no offset, O(log n)).
    //
    // limit === 0 means the caller wants counts/facets only (corpus_stats, or
    // corpus_get_state with include_sample=false) — the sample is discarded by
    // the caller. Skip the query entirely: it would not only be wasted work, but
    // `take: limit + 1` would fetch a single sentinel row that makes the
    // `sampleRows.length > limit` page-detection below misfire on a non-empty
    // corpus (sampleRows[limit - 1] === sampleRows[-1] === undefined → throw).
    const sampleRows =
      limit > 0
        ? await prisma.document.findMany({
            where: cursorArk
              ? { ...sharedWhere, ark: { gt: cursorArk } }
              : sharedWhere,
            orderBy: { ark: "asc" },
            // Fetch one extra to detect whether a next page exists.
            take: limit + 1,
            ...documentRow,
          })
        : []

    // Determine next cursor before trimming the extra row.
    let nextCursor: string | undefined
    if (sampleRows.length > limit) {
      const lastRow = sampleRows[limit - 1]
      nextCursor = `${version.seq}:${lastRow.ark}`
    }

    // Return exactly `limit` rows (drop the sentinel).
    const sample = sampleRows.slice(0, limit)

    return {
      versionSeq: version.seq,
      versionStatus: version.status as CorpusVersionStatus,
      total,
      undatedCount,
      pendingCount,
      failedCount,
      facets: {
        type: typeFacet,
        lang: langFacet,
        source: sourceFacet,
        period: periodFacet,
      },
      sessions,
      numerisation,
      sample,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    }
  }

  /**
   * Resolve a version ref ("head" | "ingested" | { seq }) to its concrete
   * CorpusVersion row. Shared by snapshot/list/crossFacets so they agree on
   * what "head" means. Throws if an "ingested" ref is requested before any
   * ingestion, or if a seq does not exist.
   */
  private static async resolveVersion(
    projectId: string,
    ref: "head" | "ingested" | { seq: number },
  ): Promise<CorpusVersionWithArks> {
    if (ref === "head") {
      return CorpusQueries.headVersion(projectId)
    }
    if (ref === "ingested") {
      const v = await CorpusQueries.ingestedVersion(projectId)
      if (!v) {
        throw new Error(`Project ${projectId} has never been ingested`)
      }
      return v
    }
    return prisma.corpusVersion.findUniqueOrThrow({
      where: { projectId_seq: { projectId, seq: ref.seq } },
      ...corpusVersionWithArks,
    })
  }

  /**
   * Returns a flat, cursor-paginated page of corpus documents matching the
   * active filters — the exhaustive-listing counterpart to `snapshot()`, which
   * computes facets. `list()` deliberately computes NO facets: it is the cheap
   * path the agent walks page-by-page to enumerate (and then act on) the corpus.
   *
   * Pagination is keyset (the same scheme as `snapshot()`'s sample): ORDER BY
   * ark ASC, cursor = `<versionSeq>:<lastArk>`, decoded as `WHERE ark > lastArk`.
   * Stable for a fixed version + filters; O(log n) per page. `nextCursor` is
   * returned iff a further page exists.
   *
   * `documents` is the full `documentRow` projection; the agent tool trims it to
   * a requested field subset (token economy) at the tool boundary, so this stays
   * fully typed.
   */
  static async list(
    projectId: string,
    ref: "head" | "ingested" | { seq: number },
    opts?: { filters?: CorpusFilterSet; cursor?: string; limit?: number },
  ): Promise<CorpusListPage> {
    const version = await CorpusQueries.resolveVersion(projectId, ref)
    const versionId = version.id
    const limit = opts?.limit ?? CORPUS_SAMPLE_SIZE
    const { sharedWhere } = buildCorpusWhere(versionId, opts?.filters)

    // Decode cursor: "<versionSeq>:<lastArk>" — only lastArk is used here.
    let cursorArk: string | undefined
    if (opts?.cursor) {
      const colonIdx = opts.cursor.indexOf(":")
      if (colonIdx !== -1) cursorArk = opts.cursor.slice(colonIdx + 1)
    }

    const [total, rows] = await Promise.all([
      prisma.document.count({ where: sharedWhere }),
      prisma.document.findMany({
        where: cursorArk
          ? { ...sharedWhere, ark: { gt: cursorArk } }
          : sharedWhere,
        orderBy: { ark: "asc" },
        // One extra row to detect whether a further page exists.
        take: limit + 1,
        ...documentRow,
      }),
    ])

    let nextCursor: string | undefined
    if (rows.length > limit) {
      nextCursor = `${version.seq}:${rows[limit - 1].ark}`
    }

    return {
      versionSeq: version.seq,
      total,
      documents: rows.slice(0, limit),
      nextCursor,
    }
  }

  /**
   * Cross-tabulate two facet dimensions over the filtered, RESOLVED corpus.
   *
   * The independent facets in `snapshot()` answer "how many books?" and "how
   * many from the 1970s?" separately; this answers "how many 1970s books?" in
   * one call — the insight the corpus agent needs to isolate a sub-population
   * (e.g. recent catalogue notices) without probing ARKs individually.
   *
   * Implemented as a single resolved-set pass binned in JS (uniform across the
   * column dims and the derived `period` decade bucket, which is not a column).
   * Cheap for typical corpus sizes; raw SQL deferred until benchmarks justify
   * it — same trade-off as the period histogram in `snapshot()`. Rows where
   * either dimension is null (e.g. undated for `period`) are skipped. `cells` is
   * sparse and sorted by count descending.
   */
  static async crossFacets(
    projectId: string,
    ref: "head" | "ingested" | { seq: number },
    dims: [CorpusFacetDimension, CorpusFacetDimension],
    filters?: CorpusFilterSet,
  ): Promise<CorpusCrossFacets> {
    const version = await CorpusQueries.resolveVersion(projectId, ref)
    const { resolvedWhere } = buildCorpusWhere(version.id, filters)

    const rows = await prisma.document.findMany({
      where: resolvedWhere,
      select: { year: true, docType: true, lang: true, source: true },
    })

    // Map a row to its value on a given dimension (null → row excluded).
    const valueOf = (
      dim: CorpusFacetDimension,
      row: { year: number | null; docType: string | null; lang: string | null; source: string | null },
    ): string | null => {
      switch (dim) {
        case "period":
          return row.year !== null ? `${Math.floor(row.year / 10) * 10}s` : null
        case "type":
          return row.docType
        case "lang":
          return row.lang
        case "source":
          return row.source
      }
    }

    // Tally combinations in a nested map (dim-A value → dim-B value → count) so
    // no separator-encoded composite key is needed — facet values may contain
    // any character, including spaces.
    const counts = new Map<string, Map<string, number>>()
    for (const row of rows) {
      const a = valueOf(dims[0], row)
      const b = valueOf(dims[1], row)
      if (a === null || b === null) continue
      const inner = counts.get(a) ?? new Map<string, number>()
      inner.set(b, (inner.get(b) ?? 0) + 1)
      counts.set(a, inner)
    }

    const cells = [...counts.entries()]
      .flatMap(([a, inner]) =>
        [...inner.entries()].map(([b, count]) => ({ a, b, count })),
      )
      .sort((x, y) => y.count - x.count)

    return { dims, cells }
  }

  /**
   * Resolve the ARKs in a version matching the given filters. Powers
   * remove-by-filter: the service resolves the target ARKs here, then either
   * previews them (dry run) or hands them to `removeArks()`. Returns the ARKs in
   * stable ascending order so a preview is reproducible.
   */
  static async arksMatchingFilters(
    projectId: string,
    ref: "head" | "ingested" | { seq: number },
    filters?: CorpusFilterSet,
  ): Promise<string[]> {
    const version = await CorpusQueries.resolveVersion(projectId, ref)
    const { sharedWhere } = buildCorpusWhere(version.id, filters)
    const rows = await prisma.document.findMany({
      where: sharedWhere,
      select: { ark: true },
      orderBy: { ark: "asc" },
    })
    return rows.map((r) => r.ark)
  }

  /**
   * Computes the diff between two corpus versions in the same project.
   *
   * Returns the ARKs that were added (present in `toSeq` but not `fromSeq`)
   * and removed (present in `fromSeq` but not `toSeq`). Sets are built in JS;
   * efficient enough for thousands of ARKs per playbook/corpus-versioning.md.
   */
  static async diff(
    projectId: string,
    fromSeq: number,
    toSeq: number,
  ): Promise<CorpusDiff> {
    const [from, to] = await Promise.all([
      prisma.corpusVersion.findUniqueOrThrow({
        where: { projectId_seq: { projectId, seq: fromSeq } },
      }),
      prisma.corpusVersion.findUniqueOrThrow({
        where: { projectId_seq: { projectId, seq: toSeq } },
      }),
    ])

    const [fromArks, toArks] = await Promise.all([
      CorpusQueries.membershipArks(from.id),
      CorpusQueries.membershipArks(to.id),
    ])

    const fromSet = new Set(fromArks)
    const toSet = new Set(toArks)

    const added = toArks.filter((a) => !fromSet.has(a))
    const removed = fromArks.filter((a) => !toSet.has(a))

    return {
      fromSeq,
      toSeq,
      added,
      removed,
      addedCount: added.length,
      removedCount: removed.length,
    }
  }
}
