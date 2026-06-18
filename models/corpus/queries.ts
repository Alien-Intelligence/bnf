// models/corpus/queries.ts
// Pure database access for the corpus model. No business logic, no external
// calls, no transforms beyond what Prisma returns.
// Imports only from @/lib/db and ./schema.
import "server-only"

import { prisma } from "@/lib/db"
import { CORPUS_SAMPLE_SIZE } from "@/lib/constants"
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
   * Facets computed: type, lang, source (exact-value counts), period
   * (per-decade bins from `year`, nulls skipped).
   *
   * Sample: up to CORPUS_SAMPLE_SIZE documents, no ordering guarantee this
   * slice (ordering + filtering land in slice 2).
   *
   * IMPORTANT: always use `total`, never `sample.length`.
   */
  static async snapshot(
    projectId: string,
    ref: "head" | "ingested" | { seq: number },
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

    // --- Total membership count -----------------------------------------------
    const total = await prisma.corpusMembership.count({ where: { versionId } })

    // --- Facets ---------------------------------------------------------------
    // Each facet is a count-by group over the documents in the version's
    // membership. We join membership → document in a single query per facet
    // dimension, then fold into a Record<string, number>.

    const [typeRows, langRows, sourceRows, periodRows] = await Promise.all([
      // Facet: docType
      prisma.document.groupBy({
        by: ["docType"],
        where: {
          membership: { some: { versionId } },
        },
        _count: { ark: true },
      }),
      // Facet: lang (skip null lang values)
      prisma.document.groupBy({
        by: ["lang"],
        where: {
          membership: { some: { versionId } },
          lang: { not: null },
        },
        _count: { ark: true },
      }),
      // Facet: source (skip null source values)
      prisma.document.groupBy({
        by: ["source"],
        where: {
          membership: { some: { versionId } },
          source: { not: null },
        },
        _count: { ark: true },
      }),
      // Period: fetch years and bin into decades client-side (JS is faster for
      // small sets than a raw SQL histogram; raw SQL approach deferred to slice 2
      // if the set grows large enough to matter).
      prisma.document.findMany({
        where: {
          membership: { some: { versionId } },
          year: { not: null },
        },
        select: { year: true },
      }),
    ])

    const typeFacet: Record<string, number> = {}
    for (const r of typeRows) {
      typeFacet[r.docType] = r._count.ark
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

    // Period: bin each year into a decade bucket ("1880s", "1890s", …).
    const periodFacet: Record<string, number> = {}
    for (const r of periodRows) {
      if (r.year === null) continue
      const decade = Math.floor(r.year / 10) * 10
      const bucket = `${decade}s`
      periodFacet[bucket] = (periodFacet[bucket] ?? 0) + 1
    }

    // --- Sample ---------------------------------------------------------------
    const sampleRows = await prisma.document.findMany({
      where: { membership: { some: { versionId } } },
      take: CORPUS_SAMPLE_SIZE,
      ...documentRow,
    })

    return {
      versionSeq: version.seq,
      versionStatus: version.status as CorpusVersionStatus,
      total,
      facets: {
        type: typeFacet,
        lang: langFacet,
        source: sourceFacet,
        period: periodFacet,
      },
      sample: sampleRows,
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
