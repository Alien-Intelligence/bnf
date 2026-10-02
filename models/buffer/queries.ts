import "server-only"
import type { Prisma } from "@/lib/generated/prisma/client"
import { prisma } from "@/lib/db"
import { BUFFER_ENRICH_STATUS, BUFFER_STATUS } from "./schema"
import type {
  BufferCrossFacets,
  BufferFacetDimension,
  BufferFacets,
  BufferFilterFields,
  BufferFilterSet,
  BufferRow,
  BufferSnapshot,
} from "./schema"

export type { BufferFilterFields, BufferFilterSet } from "./schema"

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

/** A text column the field-scoped filters match on. */
type TextColumn = "title" | "creator" | "subjects"

/** Contains-ANY over one text column, case-insensitive (ILIKE). */
function containsAny(column: TextColumn, values: string[]): Prisma.BufferItemWhereInput {
  const match = (v: string): Prisma.BufferItemWhereInput => {
    const contains = { contains: v, mode: "insensitive" as const }
    switch (column) {
      case "title":
        return { title: contains }
      case "creator":
        return { creator: contains }
      case "subjects":
        return { subjects: contains }
    }
  }
  return { OR: values.map(match) }
}

/**
 * Year bounds by OVERLAP with [year, yearEnd ?? year]: a periodical collection
 * running 1861–1946 matches yearFrom 1937. `undated` widens a range to also
 * admit null-dated rows; alone, it selects them.
 */
function yearClause(f: BufferFilterFields): Prisma.BufferItemWhereInput | null {
  const hasRange = f.yearFrom !== undefined || f.yearTo !== undefined
  if (!hasRange) return f.undated === true ? { year: null } : null
  const bounds: Prisma.BufferItemWhereInput[] = []
  if (f.yearTo !== undefined) bounds.push({ year: { lte: f.yearTo } })
  if (f.yearFrom !== undefined) {
    const from = f.yearFrom
    bounds.push({ OR: [{ yearEnd: { gte: from } }, { yearEnd: null, year: { gte: from } }] })
  }
  const range: Prisma.BufferItemWhereInput = { year: { not: null }, AND: bounds }
  return f.undated === true ? { OR: [range, { year: null }] } : range
}

/**
 * One clause per constrained dimension (AND-ed by the caller). Pure — the one
 * filter→SQL translation for the buffer, shared by the positive filters and
 * the inside of `not`.
 */
export function bufferFieldClauses(f: BufferFilterFields): Prisma.BufferItemWhereInput[] {
  const clauses: Prisma.BufferItemWhereInput[] = []
  if (f.type?.length) clauses.push({ docType: { in: f.type } })
  if (f.kind?.length) clauses.push({ arkKind: { in: f.kind } })
  if (f.lang?.length) clauses.push({ lang: { in: f.lang } })
  if (f.source?.length) clauses.push({ source: { in: f.source } })
  if (f.title?.length) clauses.push(containsAny("title", f.title))
  if (f.creator?.length) clauses.push(containsAny("creator", f.creator))
  if (f.subject?.length) clauses.push(containsAny("subjects", f.subject))
  const year = yearClause(f)
  if (year !== null) clauses.push(year)
  if (f.unresolved === true) {
    clauses.push({ enrichStatus: { in: [BUFFER_ENRICH_STATUS.PENDING, BUFFER_ENRICH_STATUS.FAILED] } })
  } else if (f.unresolved === false) {
    clauses.push({ OR: [{ enrichStatus: null }, { enrichStatus: BUFFER_ENRICH_STATUS.RESOLVED }] })
  }
  if (f.q) {
    const contains = { contains: f.q, mode: "insensitive" as const }
    clauses.push({
      OR: [{ title: contains }, { creator: contains }, { snippet: contains }, { subjects: contains }],
    })
  }
  return clauses
}

/** The dimensions of a `not` that read a nullable column, and that column. */
const NOT_PRESENCE: ReadonlyArray<{
  dimension: string
  used: (f: BufferFilterFields) => boolean
  present: Prisma.BufferItemWhereInput
  unknown: Prisma.BufferItemWhereInput
}> = [
  { dimension: "type", used: (f) => !!f.type?.length, present: { docType: { not: null } }, unknown: { docType: null } },
  { dimension: "kind", used: (f) => !!f.kind?.length, present: { arkKind: { not: null } }, unknown: { arkKind: null } },
  { dimension: "lang", used: (f) => !!f.lang?.length, present: { lang: { not: null } }, unknown: { lang: null } },
  { dimension: "source", used: (f) => !!f.source?.length, present: { source: { not: null } }, unknown: { source: null } },
  { dimension: "title", used: (f) => !!f.title?.length, present: { title: { not: null } }, unknown: { title: null } },
  { dimension: "creator", used: (f) => !!f.creator?.length, present: { creator: { not: null } }, unknown: { creator: null } },
  { dimension: "subject", used: (f) => !!f.subject?.length, present: { subjects: { not: null } }, unknown: { subjects: null } },
  {
    dimension: "year",
    used: (f) => f.yearFrom !== undefined || f.yearTo !== undefined,
    present: { year: { not: null } },
    unknown: { year: null },
  },
]

/**
 * The `not` clause: the row HAS a value for every dimension the exclusion
 * names, AND it does not match them. Decision 4: a row whose field is unknown
 * is never matched by `not` — written out explicitly rather than left to SQL
 * NULL semantics, so "remove everything not French" can never delete a row of
 * unknown language.
 */
function notClause(not: BufferFilterFields): Prisma.BufferItemWhereInput | null {
  const inner = bufferFieldClauses(not)
  if (inner.length === 0) return null
  const presence = NOT_PRESENCE.filter((p) => p.used(not)).map((p) => p.present)
  return { AND: [...presence, { NOT: { AND: inner } }] }
}

/** Decade bucket label for a year, e.g. 1887 → "1880s". */
function decadeBucket(year: number): string {
  return `${Math.floor(year / 10) * 10}s`
}

export class BufferQueries {
  /**
   * Prisma `where` for a project's CANDIDATE rows under the active filters:
   * every positive clause AND the `not` clause. Pure — see bufferFieldClauses.
   */
  static where(projectId: string, filters: BufferFilterSet = {}): Prisma.BufferItemWhereInput {
    const { not, ...positive } = filters
    const clauses = bufferFieldClauses(positive)
    const exclusion = not !== undefined ? notClause(not) : null
    if (exclusion !== null) clauses.push(exclusion)
    return {
      projectId,
      status: BUFFER_STATUS.CANDIDATE,
      ...(clauses.length > 0 ? { AND: clauses } : {}),
    }
  }

  /**
   * For a filter set with `not`: per dimension the exclusion names, how many
   * candidates match the POSITIVE clauses but have no value in that column —
   * the rows `not` deliberately left alone. A dry run reports them so "remove
   * everything not French" says how many candidates of unknown language it
   * kept. Empty when there is no `not`.
   */
  static async notUnknownCounts(projectId: string, filters: BufferFilterSet): Promise<Record<string, number>> {
    const { not, ...positive } = filters
    if (not === undefined) return {}
    const base = BufferQueries.where(projectId, positive)
    const used = NOT_PRESENCE.filter((p) => p.used(not))
    const counts = await Promise.all(
      used.map((p) => prisma.bufferItem.count({ where: { AND: [base, p.unknown] } })),
    )
    return Object.fromEntries(used.map((p, i) => [p.dimension, counts[i]]))
  }

  /**
   * The whole candidate set's enrichment state, whatever the filters: how many
   * candidates are still waiting for background metadata (`unresolved`, which
   * no filter on title/type/date can see yet) and how many the drain gave up on
   * (`unresolvedFailed`). Every buffer read returns it, so the agent checks it
   * before filtering.
   */
  static async enrichCounts(projectId: string): Promise<{ unresolved: number; unresolvedFailed: number }> {
    const where = { projectId, status: BUFFER_STATUS.CANDIDATE }
    const [unresolved, unresolvedFailed] = await Promise.all([
      prisma.bufferItem.count({ where: { ...where, enrichStatus: BUFFER_ENRICH_STATUS.PENDING } }),
      prisma.bufferItem.count({ where: { ...where, enrichStatus: BUFFER_ENRICH_STATUS.FAILED } }),
    ])
    return { unresolved, unresolvedFailed }
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
