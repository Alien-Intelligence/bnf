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
  type CorpusDiff,
  type CorpusSnapshot,
  type CorpusVersionStatus,
  type CorpusVersionWithArks,
} from "./schema"

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
      filters?: {
        type?: string[]
        lang?: string[]
        source?: string[]
        /** Ingestion classes: ocr | vision | sans_texte | non_numerise. */
        ingest?: string[]
        yearFrom?: number
        yearTo?: number
        undated?: boolean
        q?: string
      }
      cursor?: string
      limit?: number
    },
  ): Promise<CorpusSnapshot> {
    // --- Resolve the version --------------------------------------------------
    let version: CorpusVersionWithArks

    if (ref === "head") {
      version = await CorpusQueries.headVersion(projectId)
    } else if (ref === "ingested") {
      const v = await CorpusQueries.ingestedVersion(projectId)
      if (!v) {
        throw new Error(`Project ${projectId} has never been ingested`)
      }
      version = v
    } else {
      version = await prisma.corpusVersion.findUniqueOrThrow({
        where: { projectId_seq: { projectId, seq: ref.seq } },
        ...corpusVersionWithArks,
      })
    }

    const versionId = version.id
    const filters = opts?.filters
    const limit = opts?.limit ?? CORPUS_SAMPLE_SIZE

    // --- Build the shared filter WHERE clause --------------------------------
    // All facet queries and the sample query share this exact WHERE predicate
    // so that facets always reflect counts within the active filtered set.

    // Year filter: if both yearFrom/yearTo are present, use the range.
    // If only undated=true, use year IS NULL.
    // If yearFrom/yearTo AND undated both arrive, the range wins (per plan §6).
    const hasYearRange =
      filters?.yearFrom !== undefined || filters?.yearTo !== undefined
    const yearWhere: Parameters<typeof prisma.document.groupBy>[0]["where"] =
      hasYearRange
        ? {
            year: {
              ...(filters?.yearFrom !== undefined
                ? { gte: filters.yearFrom }
                : {}),
              ...(filters?.yearTo !== undefined ? { lte: filters.yearTo } : {}),
            },
          }
        : filters?.undated === true
          ? { year: null }
          : {}

    // Multi-select filters: arrays come in pre-split from the route.
    const typeWhere =
      filters?.type && filters.type.length > 0
        ? { docType: { in: filters.type } }
        : {}

    const langWhere =
      filters?.lang && filters.lang.length > 0
        ? { lang: { in: filters.lang } }
        : {}

    const sourceWhere =
      filters?.source && filters.source.length > 0
        ? { source: { in: filters.source } }
        : {}

    // Full-text: Prisma OR over contains (ILIKE on Postgres, mode-insensitive).
    // We match title, author, and excerpt. excerpt may be null — Prisma skips
    // null columns in LIKE comparisons automatically.
    const fullTextWhere =
      filters?.q && filters.q.trim().length > 0
        ? {
            OR: [
              {
                title: {
                  contains: filters.q,
                  mode: "insensitive" as const,
                },
              },
              {
                author: {
                  contains: filters.q,
                  mode: "insensitive" as const,
                },
              },
              {
                excerpt: {
                  contains: filters.q,
                  mode: "insensitive" as const,
                },
              },
            ],
          }
        : {}

    // Ingestion-class filter: an OR over the selected classes, each a SQL
    // mirror of classifyIngestion(). Constrained to resolved rows (the class is
    // unknown for stubs). null when no class is selected.
    const ingestPredicates =
      filters?.ingest && filters.ingest.length > 0
        ? filters.ingest
            .map(ingestClassWhere)
            .filter((w): w is Prisma.DocumentWhereInput => w !== null)
        : []
    const ingestWhere: Prisma.DocumentWhereInput | null =
      ingestPredicates.length > 0
        ? {
            resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
            OR: ingestPredicates,
          }
        : null

    // Combine all filter clauses. Every doc must be in this version's
    // membership AND satisfy the active filter predicates. fullText and ingest
    // each carry their own `OR`, so they are AND-ed via an explicit `AND` array
    // rather than spread (two `OR` keys at one level would collide).
    const andClauses: Prisma.DocumentWhereInput[] = []
    if (filters?.q && filters.q.trim().length > 0) andClauses.push(fullTextWhere)
    if (ingestWhere) andClauses.push(ingestWhere)

    const sharedWhere = {
      membership: { some: { versionId } },
      ...typeWhere,
      ...langWhere,
      ...sourceWhere,
      ...yearWhere,
      ...(andClauses.length > 0 ? { AND: andClauses } : {}),
    }

    // Resolved-only predicate for the type/lang/period facets and undatedCount:
    // pending/failed stubs have no type/lang/year yet, so they must not pollute
    // the real buckets. They surface separately via pendingCount/failedCount and
    // the synthetic PENDING_FACET_KEY bucket below.
    const resolvedWhere = {
      ...sharedWhere,
      resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
    }

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
    const sampleRows = await prisma.document.findMany({
      where: cursorArk
        ? { ...sharedWhere, ark: { gt: cursorArk } }
        : sharedWhere,
      orderBy: { ark: "asc" },
      // Fetch one extra to detect whether a next page exists.
      take: limit + 1,
      ...documentRow,
    })

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
      numerisation,
      sample,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    }
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
