import "server-only"
import type { Prisma } from "@/lib/generated/prisma/client"
import { prisma } from "@/lib/db"
import { BUFFER_ENRICH_STATUS, BUFFER_STATUS } from "./schema"
import type {
  BufferCrossFacets,
  BufferFacetDimension,
  BufferFacets,
  BufferRow,
  BufferSnapshot,
} from "./schema"

/**
 * The canonical (array-based) buffer filter set — the buffer's counterpart to
 * `CorpusFilterSet`. Queries, the BufferService, and the agent buffer tools all
 * speak this shape; the CSV `BufferFilters` in types.ts is only the REST/UI
 * query-string boundary form (converted via splitCsv in the route). All fields
 * optional; absent means "no constraint on this dimension".
 */
export type BufferFilterSet = {
  type?: string[]
  lang?: string[]
  source?: string[]
  yearFrom?: number
  yearTo?: number
  /** Include candidates with no date. Ignored when yearFrom/yearTo is set. */
  undated?: boolean
  q?: string
}

/** Fields projected for the buffer panel + buffer_list tool. */
const bufferRowSelect = {
  id: true,
  ark: true,
  title: true,
  year: true,
  docType: true,
  lang: true,
  source: true,
  snippet: true,
  originQuery: true,
  createdAt: true,
  creator: true,
  dateLabel: true,
  arkKind: true,
  subjects: true,
  enrichStatus: true,
} satisfies Prisma.BufferItemSelect

/** Decade bucket label for a year, e.g. 1887 → "1880s". */
function decadeBucket(year: number): string {
  return `${Math.floor(year / 10) * 10}s`
}

export class BufferQueries {
  /**
   * Prisma `where` for a project's CANDIDATE rows under the active filters.
   * Multi-selects (type/lang/source) are OR-within / AND-across dimensions; the
   * year range and `undated` combine so an explicit `undated` widens a bounded
   * range to also admit null-dated candidates.
   */
  static where(projectId: string, filters: BufferFilterSet = {}): Prisma.BufferItemWhereInput {
    const where: Prisma.BufferItemWhereInput = {
      projectId,
      status: BUFFER_STATUS.CANDIDATE,
    }

    if (filters.type?.length) where.docType = { in: filters.type }
    if (filters.lang?.length) where.lang = { in: filters.lang }
    if (filters.source?.length) where.source = { in: filters.source }

    const hasRange = filters.yearFrom !== undefined || filters.yearTo !== undefined
    if (hasRange) {
      const range: Prisma.IntNullableFilter = {}
      if (filters.yearFrom !== undefined) range.gte = filters.yearFrom
      if (filters.yearTo !== undefined) range.lte = filters.yearTo
      where.OR = filters.undated ? [{ year: range }, { year: null }] : [{ year: range }]
    } else if (filters.undated === true) {
      where.year = null
    }

    if (filters.q) {
      const q = filters.q
      // Text search is a separate AND clause so it composes with the year OR.
      where.AND = [
        {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { snippet: { contains: q, mode: "insensitive" } },
          ],
        },
      ]
    }

    return where
  }

  /** Count of candidates matching the filters. */
  static async count(projectId: string, filters: BufferFilterSet = {}): Promise<number> {
    return prisma.bufferItem.count({ where: BufferQueries.where(projectId, filters) })
  }

  /** One page of candidates (newest first), plus the total match count. */
  static async list(
    projectId: string,
    filters: BufferFilterSet = {},
    limit = 25,
  ): Promise<{ total: number; rows: BufferRow[] }> {
    const where = BufferQueries.where(projectId, filters)
    const [total, rows] = await Promise.all([
      prisma.bufferItem.count({ where }),
      prisma.bufferItem.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: bufferRowSelect,
      }),
    ])
    return { total, rows }
  }

  /** All candidate ARKs matching the filters — the match set for
   *  remove-by-filter and the commit set. Bounded by the buffer's own size. */
  static async candidateArks(projectId: string, filters: BufferFilterSet = {}): Promise<string[]> {
    const rows = await prisma.bufferItem.findMany({
      where: BufferQueries.where(projectId, filters),
      select: { ark: true },
    })
    return rows.map((r) => r.ark)
  }

  /** total + facets + a bounded sample — the buffer comprehension shape. */
  static async snapshot(
    projectId: string,
    filters: BufferFilterSet = {},
    sampleSize = 25,
  ): Promise<BufferSnapshot> {
    const where = BufferQueries.where(projectId, filters)
    const [total, facets, sample] = await Promise.all([
      prisma.bufferItem.count({ where }),
      BufferQueries.facets(projectId, filters),
      prisma.bufferItem.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: sampleSize,
        select: bufferRowSelect,
      }),
    ])
    return { total, facets, sample }
  }

  /** Facet distribution over the filtered candidate set. */
  static async facets(projectId: string, filters: BufferFilterSet = {}): Promise<BufferFacets> {
    const where = BufferQueries.where(projectId, filters)
    const [byType, byKind, byLang, bySource, years, unresolved] = await Promise.all([
      prisma.bufferItem.groupBy({
        by: ["docType"],
        where: { ...where, docType: { not: null } },
        _count: { _all: true },
      }),
      prisma.bufferItem.groupBy({
        by: ["arkKind"],
        where: { ...where, arkKind: { not: null } },
        _count: { _all: true },
      }),
      prisma.bufferItem.groupBy({
        by: ["lang"],
        where: { ...where, lang: { not: null } },
        _count: { _all: true },
      }),
      prisma.bufferItem.groupBy({
        by: ["source"],
        where: { ...where, source: { not: null } },
        _count: { _all: true },
      }),
      prisma.bufferItem.findMany({ where, select: { year: true } }),
      prisma.bufferItem.count({ where: { ...where, enrichStatus: BUFFER_ENRICH_STATUS.PENDING } }),
    ])

    const toRecord = <K extends string>(
      rows: Array<{ _count: { _all: number } } & Record<K, string | null>>,
      field: K,
    ): Record<string, number> => {
      const out: Record<string, number> = {}
      for (const row of rows) {
        const k = row[field]
        if (k !== null) out[k] = row._count._all
      }
      return out
    }

    const period: Record<string, number> = {}
    let undated = 0
    for (const { year } of years) {
      if (year === null) undated += 1
      else period[decadeBucket(year)] = (period[decadeBucket(year)] ?? 0) + 1
    }

    return {
      type: toRecord(byType, "docType"),
      kind: toRecord(byKind, "arkKind"),
      lang: toRecord(byLang, "lang"),
      source: toRecord(bySource, "source"),
      period,
      undated,
      unresolved,
    }
  }

  /**
   * A crossed-facet table over two dimensions (sparse, count-desc). Computed
   * in-memory over the filtered candidate set — the buffer is small (curation
   * scratch), so a single scan is cheaper than SQL cubes.
   */
  static async crossFacets(
    projectId: string,
    dims: [BufferFacetDimension, BufferFacetDimension],
    filters: BufferFilterSet = {},
  ): Promise<BufferCrossFacets> {
    const rows = await prisma.bufferItem.findMany({
      where: BufferQueries.where(projectId, filters),
      select: { docType: true, arkKind: true, lang: true, source: true, year: true },
    })

    const value = (
      row: {
        docType: string | null
        arkKind: string | null
        lang: string | null
        source: string | null
        year: number | null
      },
      dim: BufferFacetDimension,
    ): string | null => {
      switch (dim) {
        case "type":
          return row.docType
        case "kind":
          return row.arkKind
        case "lang":
          return row.lang
        case "source":
          return row.source
        case "period":
          return row.year !== null ? decadeBucket(row.year) : null
      }
    }

    const counts = new Map<string, { a: string; b: string; count: number }>()
    for (const row of rows) {
      const a = value(row, dims[0])
      const b = value(row, dims[1])
      if (a === null || b === null) continue
      const cellKey = `${a} ${b}`
      const cell = counts.get(cellKey)
      if (cell) cell.count += 1
      else counts.set(cellKey, { a, b, count: 1 })
    }

    const cells = [...counts.values()].sort((x, y) => y.count - x.count)
    return { dims, cells }
  }
}
