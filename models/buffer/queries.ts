import "server-only"
// models/buffer/queries.ts
// Pure database access for the research buffer. No filter semantics: every
// read takes the Prisma `where` BufferService built (BufferService.where), so
// the filter→SQL translation lives in one place, in the service.
import type { Prisma } from "@/lib/generated/prisma/client"
import { prisma } from "@/lib/db"
import { BUFFER_SAMPLE_SIZE } from "@/lib/constants"
import { BUFFER_ENRICH_STATUS, BUFFER_STATUS } from "./schema"
import type { BufferCrossFacets, BufferFacetDimension, BufferFacets, BufferRow, BufferSnapshot } from "./schema"

/** A candidate still waiting for its background metadata — the ONE
 *  definition every "unresolved" count uses. */
const PENDING_ENRICH: Prisma.BufferItemWhereInput = { enrichStatus: BUFFER_ENRICH_STATUS.PENDING }

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
  /** A project's candidate rows, unfiltered — the scope every filtered `where` narrows. */
  static candidateScope(projectId: string): Prisma.BufferItemWhereInput {
    return { projectId, status: BUFFER_STATUS.CANDIDATE }
  }

  /**
   * The whole candidate set's enrichment state, whatever the filters: how many
   * candidates are still waiting for background metadata (`unresolved`, which
   * no filter on title/type/date can see yet) and how many the drain gave up on
   * (`unresolvedFailed`). Every buffer read returns it, so the agent checks it
   * before filtering.
   */
  static async enrichCounts(projectId: string): Promise<{ unresolved: number; unresolvedFailed: number }> {
    const where = BufferQueries.candidateScope(projectId)
    const [unresolved, unresolvedFailed] = await Promise.all([
      prisma.bufferItem.count({ where: { ...where, ...PENDING_ENRICH } }),
      prisma.bufferItem.count({ where: { ...where, enrichStatus: BUFFER_ENRICH_STATUS.FAILED } }),
    ])
    return { unresolved, unresolvedFailed }
  }

  /** Of the given ARKs, how many are candidates still waiting for metadata. */
  static async pendingEnrichAmong(projectId: string, arks: string[]): Promise<number> {
    return prisma.bufferItem.count({
      where: { ...BufferQueries.candidateScope(projectId), ark: { in: arks }, ...PENDING_ENRICH },
    })
  }

  /** Count of rows matching `where`. */
  static async count(where: Prisma.BufferItemWhereInput): Promise<number> {
    return prisma.bufferItem.count({ where })
  }

  /** One page of rows (newest first), plus the total match count. */
  static async list(
    where: Prisma.BufferItemWhereInput,
    limit: number = BUFFER_SAMPLE_SIZE,
  ): Promise<{ total: number; rows: BufferRow[] }> {
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

  /** Every ARK matching `where`. Bounded by the buffer's own size. */
  static async arks(where: Prisma.BufferItemWhereInput): Promise<string[]> {
    const rows = await prisma.bufferItem.findMany({ where, select: { ark: true } })
    return rows.map((r) => r.ark)
  }

  /** total + facets + a bounded sample — the buffer comprehension shape. */
  static async snapshot(
    where: Prisma.BufferItemWhereInput,
    sampleSize: number = BUFFER_SAMPLE_SIZE,
  ): Promise<BufferSnapshot> {
    const [total, facets, sample] = await Promise.all([
      prisma.bufferItem.count({ where }),
      BufferQueries.facets(where),
      prisma.bufferItem.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: sampleSize,
        select: bufferRowSelect,
      }),
    ])
    return { total, facets, sample }
  }

  /** Facet distribution over the rows matching `where`. */
  static async facets(where: Prisma.BufferItemWhereInput): Promise<BufferFacets> {
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
      prisma.bufferItem.count({ where: { ...where, ...PENDING_ENRICH } }),
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
    where: Prisma.BufferItemWhereInput,
    dims: [BufferFacetDimension, BufferFacetDimension],
  ): Promise<BufferCrossFacets> {
    const rows = await prisma.bufferItem.findMany({
      where,
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
