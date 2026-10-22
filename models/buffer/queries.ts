import "server-only"
// models/buffer/queries.ts
// Pure database access for the research buffer. No filter semantics: every
// read takes the Prisma `where` BufferService built (BufferService.where), so
// the filter→SQL translation lives in one place, in the service.
import { prisma } from "@/lib/db"
import {
  BUFFER_ENRICH_STATUS,
  BUFFER_STATUS,
  BUFFER_UNRESOLVED_ENRICH_STATUSES,
  bufferRowSelect,
  existingRowSelect,
  legacyRowSelect,
} from "./schema"
import type {
  BufferCrossFacets,
  BufferEnrichmentWrite,
  BufferFacetDimension,
  BufferFacets,
  BufferInsert,
  BufferReclassificationUpdate,
  BufferRegistrationCounts,
  BufferRegistrationTransitions,
  BufferRow,
  BufferSnapshot,
  BufferWhere,
  ExistingBufferRow,
  InsertedBufferRow,
  LegacyBufferItem,
} from "./schema"

/** A candidate without its metadata (BUFFER_UNRESOLVED_ENRICH_STATUSES) —
 *  every "unresolved" count, and the `unresolved` filter, read this set. */
const UNRESOLVED: BufferWhere = { enrichStatus: { in: [...BUFFER_UNRESOLVED_ENRICH_STATUSES] } }

/** A candidate the drain may still take: pending (a failed one is final). */
const PENDING_ENRICH: BufferWhere = { enrichStatus: BUFFER_ENRICH_STATUS.PENDING }

/** A pending candidate the enrichment drain may take now: under the attempt
 *  ceiling, and past its backoff. */
function readyToEnrich(now: Date, maxAttempts: number): BufferWhere {
  return {
    status: BUFFER_STATUS.CANDIDATE,
    ...PENDING_ENRICH,
    enrichAttempts: { lt: maxAttempts },
    OR: [{ enrichNextAttemptAt: null }, { enrichNextAttemptAt: { lte: now } }],
  }
}

/** Decade bucket label for a year, e.g. 1887 → "1880s". */
function decadeBucket(year: number): string {
  return `${Math.floor(year / 10) * 10}s`
}

export class BufferQueries {
  /** A project's candidate rows, unfiltered — the scope every filtered `where` narrows. */
  static candidateScope(projectId: string): BufferWhere {
    return { projectId, status: BUFFER_STATUS.CANDIDATE }
  }

  /** The languages the project's candidates hold — what the language facet shows. */
  static async langsHeld(projectId: string): Promise<string[]> {
    const rows = await prisma.bufferItem.findMany({
      where: { ...BufferQueries.candidateScope(projectId), lang: { not: null } },
      distinct: ["lang"],
      select: { lang: true },
      orderBy: { lang: "asc" },
    })
    return rows.flatMap((r) => (r.lang !== null ? [r.lang] : []))
  }

  /**
   * The whole candidate set's enrichment state, whatever the filters: how many
   * candidates are without their metadata (`unresolved` — the same set the
   * `unresolved: true` filter selects; no filter on title/type/date can see
   * them) and, of those, how many the drain gave up on (`unresolvedFailed`).
   * Every buffer read returns it, so the agent checks it before filtering.
   */
  static async enrichCounts(projectId: string): Promise<{ unresolved: number; unresolvedFailed: number }> {
    const where = BufferQueries.candidateScope(projectId)
    const [unresolved, unresolvedFailed] = await Promise.all([
      prisma.bufferItem.count({ where: { ...where, ...UNRESOLVED } }),
      prisma.bufferItem.count({ where: { ...where, enrichStatus: BUFFER_ENRICH_STATUS.FAILED } }),
    ])
    return { unresolved, unresolvedFailed }
  }

  /** Of the given ARKs, how many are candidates without their metadata. */
  static async unresolvedAmong(projectId: string, arks: string[]): Promise<number> {
    return prisma.bufferItem.count({
      where: { ...BufferQueries.candidateScope(projectId), ark: { in: arks }, ...UNRESOLVED },
    })
  }

  /** One drain batch of a project: ready rows, fewest attempts first. */
  static async enrichBatch(
    projectId: string,
    now: Date,
    maxAttempts: number,
    take: number,
  ): Promise<Array<{ ark: string; enrichAttempts: number }>> {
    return prisma.bufferItem.findMany({
      where: { projectId, ...readyToEnrich(now, maxAttempts) },
      select: { ark: true, enrichAttempts: true },
      orderBy: [{ enrichAttempts: "asc" }, { createdAt: "asc" }],
      take,
    })
  }

  /** The projects with at least one row the drain may take now. */
  static async projectsReadyToEnrich(now: Date, maxAttempts: number): Promise<string[]> {
    const rows = await prisma.bufferItem.findMany({
      where: readyToEnrich(now, maxAttempts),
      distinct: ["projectId"],
      select: { projectId: true },
    })
    return rows.map((r) => r.projectId)
  }

  /**
   * Write one row's enrichment outcome, guarded: only while it is still a
   * pending candidate. Returns false when it no longer is — buffer_clear or a
   * discard removed it mid-drain — so the drain moves on instead of aborting
   * on a missing row.
   */
  static async writeEnrichment(
    projectId: string,
    ark: string,
    data: BufferEnrichmentWrite,
  ): Promise<boolean> {
    const { count } = await prisma.bufferItem.updateMany({
      where: { projectId, ark, status: BUFFER_STATUS.CANDIDATE, ...PENDING_ENRICH },
      data,
    })
    return count === 1
  }

  /** The next rows below `version`, in id order after `cursor`. */
  static async legacyBatch(version: number, cursor: string | null, take: number): Promise<LegacyBufferItem[]> {
    return prisma.bufferItem.findMany({
      where: { classifierVersion: { lt: version }, ...(cursor !== null ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      take,
      select: legacyRowSelect,
    })
  }

  /**
   * Apply one batch of reclassifications in one transaction, each guarded on
   * the version: a row a live search re-stamped between the read and the
   * write is left as the search wrote it. `queueEnrich` queues the row for the
   * drain ONLY while it has never been enriched (enrichStatus NULL), checked
   * in the same statement — so a terminal status (failed, resolved), even one
   * the drain wrote after the batch was read, is never regressed to pending.
   * Returns how many rows were reclassified.
   */
  static async applyReclassification(
    version: number,
    updates: ReadonlyArray<BufferReclassificationUpdate>,
  ): Promise<number> {
    const statements = updates.flatMap((u) => [
      ...(u.queueEnrich
        ? [
            prisma.bufferItem.updateMany({
              where: { id: u.id, classifierVersion: { lt: version }, enrichStatus: null },
              data: { enrichStatus: BUFFER_ENRICH_STATUS.PENDING },
            }),
          ]
        : []),
      prisma.bufferItem.updateMany({ where: { id: u.id, classifierVersion: { lt: version } }, data: u.data }),
    ])
    const results = await prisma.$transaction(statements)
    // One classification write per update, always last of its group.
    let reclassified = 0
    let i = 0
    for (const u of updates) {
      i += u.queueEnrich ? 2 : 1
      reclassified += results[i - 1].count
    }
    return reclassified
  }

  /** The existing rows of the given ARKs in a project. */
  static async existingRows(projectId: string, arks: string[]): Promise<ExistingBufferRow[]> {
    return prisma.bufferItem.findMany({
      where: { projectId, ark: { in: arks } },
      select: existingRowSelect,
    })
  }

  /**
   * Insert never-seen rows. skipDuplicates makes it race-safe: the result is
   * exactly the rows THIS call inserted, a row a parallel call inserted first
   * is absent from it.
   */
  static async insertMany(data: BufferInsert[]): Promise<InsertedBufferRow[]> {
    if (data.length === 0) return []
    return prisma.bufferItem.createManyAndReturn({
      data,
      skipDuplicates: true,
      select: { ark: true, status: true },
    })
  }

  /**
   * Apply one registration's metadata refreshes and status transitions in one
   * transaction. Every transition is a guarded updateMany, so the counts are
   * what THIS call moved. A bare row that just became a candidate again is
   * curated again: it is queued for enrichment (never re-queues a row the
   * drain gave up on).
   */
  static async applyRegistration(
    projectId: string,
    t: BufferRegistrationTransitions,
  ): Promise<BufferRegistrationCounts> {
    const inStatus = (arks: string[], status: string): BufferWhere => ({ projectId, ark: { in: arks }, status })
    const results = await prisma.$transaction([
      ...t.refreshes.map((r) =>
        prisma.bufferItem.update({ where: { projectId_ark: { projectId, ark: r.ark } }, data: r.data }),
      ),
      prisma.bufferItem.updateMany({
        where: { projectId, ark: { in: t.toCommitted }, status: { not: BUFFER_STATUS.COMMITTED } },
        data: { status: BUFFER_STATUS.COMMITTED },
      }),
      prisma.bufferItem.updateMany({
        where: inStatus(t.toRestage, BUFFER_STATUS.COMMITTED),
        data: { status: BUFFER_STATUS.CANDIDATE },
      }),
      prisma.bufferItem.updateMany({
        where: inStatus(t.toUndiscard, BUFFER_STATUS.DISCARDED),
        data: { status: BUFFER_STATUS.CANDIDATE },
      }),
      prisma.bufferItem.updateMany({
        where: {
          projectId,
          ark: { in: [...t.toRestage, ...t.toUndiscard] },
          status: BUFFER_STATUS.CANDIDATE,
          title: null,
          enrichStatus: null,
        },
        data: { enrichStatus: BUFFER_ENRICH_STATUS.PENDING },
      }),
    ])
    const transitionCount = (offset: number): number => {
      const r = results[t.refreshes.length + offset]
      if (typeof r !== "object" || r === null || !("count" in r) || typeof r.count !== "number") {
        throw new Error(`registerCandidates: transition ${offset} returned no count`)
      }
      return r.count
    }
    return { restaged: transitionCount(1), undiscarded: transitionCount(2) }
  }

  /** Mark the project's candidates among `arks` as `discarded`. Returns how many. */
  static async discard(projectId: string, arks: string[]): Promise<number> {
    const { count } = await prisma.bufferItem.updateMany({
      where: { projectId, ark: { in: arks }, status: BUFFER_STATUS.CANDIDATE },
      data: { status: BUFFER_STATUS.DISCARDED },
    })
    return count
  }

  /** Mark the project's candidates among `arks` as `committed`. */
  static async markCommitted(projectId: string, arks: string[]): Promise<void> {
    await prisma.bufferItem.updateMany({
      where: { projectId, ark: { in: arks }, status: BUFFER_STATUS.CANDIDATE },
      data: { status: BUFFER_STATUS.COMMITTED },
    })
  }

  /** Delete the project's candidate and discarded rows (committed ones stay as provenance). */
  static async clear(projectId: string): Promise<number> {
    const { count } = await prisma.bufferItem.deleteMany({
      where: { projectId, status: { in: [BUFFER_STATUS.CANDIDATE, BUFFER_STATUS.DISCARDED] } },
    })
    return count
  }

  /** Count of rows matching `where`. */
  static async count(where: BufferWhere): Promise<number> {
    return prisma.bufferItem.count({ where })
  }

  /** One page of rows (newest first), plus the total match count. */
  static async list(
    where: BufferWhere,
    limit: number,
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
  static async arks(where: BufferWhere): Promise<string[]> {
    const rows = await prisma.bufferItem.findMany({ where, select: { ark: true } })
    return rows.map((r) => r.ark)
  }

  /** total + facets + a bounded sample — the buffer comprehension shape. */
  static async snapshot(
    where: BufferWhere,
    sampleSize: number,
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
  static async facets(where: BufferWhere): Promise<BufferFacets> {
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
      prisma.bufferItem.count({ where: { ...where, ...UNRESOLVED } }),
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
    where: BufferWhere,
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
