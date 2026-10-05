// models/corpus/queries.ts
// Pure database access for the corpus model. No business logic, no external
// calls, no transforms beyond what Prisma returns. The filtered reads run the
// predicates CorpusService built (lib/corpus/filter-where.ts); no filter
// semantics live here. Imports only from @/lib/db and ./schema.
import "server-only"

import { prisma } from "@/lib/db"
import type { Prisma } from "@/lib/generated/prisma/client"
import {
  corpusVersionWithArks,
  documentRow,
  type CorpusCrossFacets,
  type CorpusDiff,
  type CorpusFacetDimension,
  type CorpusListPage,
  type DocumentRow,
  type CorpusVersionStatus,
  type CorpusVersionWithArks,
  type CorpusSnapshotRead,
  type CorpusWherePredicates,
} from "./schema"

export class CorpusQueries {
  /**
   * Whether the project pays for fallback OCR. It decides whether a digitized,
   * OCR-less, Latin-script document counts as `excluded` ("nothing to index")
   * or `not_ingested` ("nothing has covered it yet") — see classifyOutcome().
   * A missing project throws: reading the corpus of a project that does not
   * exist is a caller bug, not a reason to guess the flag.
   */
  static async paidOcrEnabled(projectId: string): Promise<boolean> {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { paidOcrEnabled: true },
    })
    return project.paidOcrEnabled
  }

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
   * Every ARK that has been in this project's corpus in ANY version.
   *
   * The validation set for citations (playbook/citations.md): a note may cite a
   * document that a later version removed — the note was true when written, and
   * its citation still resolves in the IIIF viewer. What it may not do is cite
   * an ARK that was never in the corpus at all, which is the shape a fabricated
   * citation takes. Deliberately broader than `membershipArks(versionId)`.
   */
  static async allArksInProject(projectId: string): Promise<string[]> {
    const rows = await prisma.corpusMembership.findMany({
      where: { projectId },
      select: { ark: true },
      distinct: ["ark"],
    })
    return rows.map((r) => r.ark)
  }

  /**
   * Which of `arks` are members of the project's HEAD version. Bounded by the
   * size of `arks` (a staging batch, ≤ 5 000) through the (versionId, ark)
   * primary key — never loads the whole membership. The buffer uses it to keep
   * documents already in the corpus out of the candidate set, and to restage
   * ones removed from it since (models/buffer/service.ts registerCandidates).
   */
  static async headMembersAmong(projectId: string, arks: string[]): Promise<Set<string>> {
    if (arks.length === 0) return new Set()
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { headVersionId: true },
    })
    if (!project.headVersionId) {
      throw new Error(`Project ${projectId} has no headVersionId — invariant 1 violated`)
    }
    const rows = await prisma.corpusMembership.findMany({
      where: { versionId: project.headVersionId, ark: { in: arks } },
      select: { ark: true },
    })
    return new Set(rows.map((r) => r.ark))
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
    version: CorpusVersionWithArks,
    paidOcr: boolean,
    where: CorpusWherePredicates,
    opts: { cursor?: string; limit: number },
  ): Promise<CorpusSnapshotRead> {
    const limit = opts.limit
    const { sharedWhere, resolvedWhere, outcomeWheres } = where

    // --- Decode cursor -------------------------------------------------------
    // Cursor format: "<versionSeq>:<lastArk>" — we only use lastArk here.
    // versionSeq is included in the cursor so the client can detect a version
    // change (invalidated cursor), but we do not validate it on the server —
    // the Prisma WHERE clause naturally returns an empty page if the ARK is
    // gone, which is safe.
    let cursorArk: string | undefined
    if (opts.cursor) {
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
      indexedCount,
      indexFailedCount,
      excludedCount,
      notIngestedCount,
    ] = await Promise.all([
      // Total within filtered set (includes pending/failed members when no
      // type/lang/year/q filter excludes them).
      prisma.document.count({ where: sharedWhere }),
      prisma.document.count({ where: where.undatedWhere }),
      prisma.document.count({ where: where.pendingWhere }),
      prisma.document.count({ where: where.failedWhere }),

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

      // --- Indexation outcome counts (CorpusWherePredicates.outcomeWheres) ---
      prisma.document.count({ where: outcomeWheres.indexed }),
      prisma.document.count({ where: outcomeWheres.failed }),
      prisma.document.count({ where: outcomeWheres.excluded }),
      prisma.document.count({ where: outcomeWheres.not_ingested }),
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

    // Bin years into decade buckets ("1880s", "1890s", …). The numérisation
    // buckets are classified from the same rows by the service.
    const periodFacet: Record<string, number> = {}
    for (const r of resolvedRows) {
      if (r.year !== null) {
        const bucket = `${Math.floor(r.year / 10) * 10}s`
        periodFacet[bucket] = (periodFacet[bucket] ?? 0) + 1
      }
    }

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
      classRows: resolvedRows,
      paidOcrEnabled: paidOcr,
      indexation: {
        indexed: indexedCount,
        failed: indexFailedCount,
        excluded: excludedCount,
        notIngested: notIngestedCount,
      },
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
  static async resolveVersion(
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
    version: CorpusVersionWithArks,
    paidOcr: boolean,
    sharedWhere: Prisma.DocumentWhereInput,
    opts: { cursor?: string; limit: number },
  ): Promise<CorpusListPage> {
    const limit = opts.limit

    // Decode cursor: "<versionSeq>:<lastArk>" — only lastArk is used here.
    let cursorArk: string | undefined
    if (opts.cursor) {
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
      paidOcrEnabled: paidOcr,
      documents: rows.slice(0, limit),
      nextCursor,
    }
  }

  /**
   * Returns every document in a version matching the active filters, ordered by
   * ark — the unbounded read behind the CSV export. Unlike `list()` there is no
   * pagination: a file export needs the whole set in one pass. This is the same
   * full-scan trade-off `diff()` and `snapshot()`'s resolved pass already make;
   * corpus sizes are in the thousands (see playbook/corpus-versioning.md).
   *
   * Shares the one `buildCorpusWhere` membership+filter predicate every corpus
   * read uses, so the export honours the comprehension panel's active filters
   * exactly — exporting the filtered subset the librarian is looking at, not a
   * different population. Includes pending/failed stubs (they are real members);
   * their `resolveStatus` column tells the consumer they are not yet resolved.
   */
  static async exportRows(
    version: CorpusVersionWithArks,
    paidOcr: boolean,
    sharedWhere: Prisma.DocumentWhereInput,
  ): Promise<{ versionSeq: number; rows: DocumentRow[]; paidOcrEnabled: boolean }> {
    const rows = await prisma.document.findMany({
      where: sharedWhere,
      orderBy: { ark: "asc" },
      ...documentRow,
    })
    return { versionSeq: version.seq, rows, paidOcrEnabled: paidOcr }
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
    resolvedWhere: Prisma.DocumentWhereInput,
    dims: [CorpusFacetDimension, CorpusFacetDimension],
  ): Promise<CorpusCrossFacets> {
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

  /** The ARKs matching `where`, in stable ascending order (a reproducible preview). */
  static async arks(where: Prisma.DocumentWhereInput): Promise<string[]> {
    const rows = await prisma.document.findMany({ where, select: { ark: true }, orderBy: { ark: "asc" } })
    return rows.map((r) => r.ark)
  }

  /** One count per predicate, in one transaction (one state of the corpus). */
  static async counts(wheres: ReadonlyArray<Prisma.DocumentWhereInput>): Promise<number[]> {
    if (wheres.length === 0) return []
    return prisma.$transaction(wheres.map((where) => prisma.document.count({ where })))
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
