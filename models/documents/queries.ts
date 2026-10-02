// models/documents/queries.ts
// Pure database access for the documents model.
// Imports only from @/lib/db and ./schema.
import "server-only"

import { prisma } from "@/lib/db"
import {
  type Document,
  OCR_SYNC_STATUS,
  documentFolioRow,
  documentOcrWithFolios,
  type DocumentFolioRow,
  type DocumentOcrWithFolios,
} from "./schema"

/** One cited (or retrieved) folio — the input of DocumentQueries.ocrForRefs. */
export type FolioRef = { ark: string; folio: number }

export class DocumentQueries {
  /**
   * Fetches a single document by its composite key (projectId, ark).
   * Returns null if not found.
   */
  static async getByArk(
    projectId: string,
    ark: string,
  ): Promise<Document | null> {
    return prisma.document.findUnique({
      where: { projectId_ark: { projectId, ark } },
    })
  }

  /**
   * Lists all documents that are members of a given corpus version.
   * Joins corpus_membership → document via the composite FK.
   *
   * `opts.take` limits the result set (used by the sample query in
   * CorpusQueries.snapshot). No pagination yet — full list support and
   * filter/search land in slice 2.
   */
  static async listByVersion(
    versionId: string,
    opts?: { take?: number },
  ): Promise<Document[]> {
    return prisma.document.findMany({
      where: {
        membership: { some: { versionId } },
      },
      take: opts?.take,
    })
  }

  // -------------------------------------------------------------------------
  // OCR quality (DocumentOcr / DocumentFolio — global per ARK, plan D8).
  // These read the global tables WITHOUT a corpus filter: every caller gates on
  // the reader's corpus first (Citation rows, isIndexedInCorpus, or the
  // project's own RAG dataset).
  // -------------------------------------------------------------------------

  /**
   * The stored quality of the given (ark, folio) pairs — one PK-scoped query.
   * Pairs with no stored folio are simply absent from the result (pending).
   */
  static async ocrForRefs(refs: FolioRef[]): Promise<DocumentFolioRow[]> {
    if (refs.length === 0) return []
    const byArk = new Map<string, Set<number>>()
    for (const r of refs) {
      const folios = byArk.get(r.ark) ?? new Set<number>()
      folios.add(r.folio)
      byArk.set(r.ark, folios)
    }
    return prisma.documentFolio.findMany({
      where: {
        OR: [...byArk].map(([ark, folios]) => ({ ark, folio: { in: [...folios] } })),
      },
      ...documentFolioRow,
    })
  }

  /** A document's OCR summary with every stored folio, or null (pending). */
  static async ocrForArk(ark: string): Promise<DocumentOcrWithFolios | null> {
    return prisma.documentOcr.findUnique({ where: { ark }, ...documentOcrWithFolios })
  }

  /** The OCR summaries of several ARKs with their folios (rag_keyword_search hits). */
  static async ocrForArks(arks: string[]): Promise<DocumentOcrWithFolios[]> {
    if (arks.length === 0) return []
    return prisma.documentOcr.findMany({
      where: { ark: { in: arks } },
      ...documentOcrWithFolios,
    })
  }

  /**
   * Indexed ARKs (in any project) whose OCR quality the sync must (re)ask the
   * worker about:
   *   - no DocumentOcr row yet (pending) — first;
   *   - `building` rows checked before `buildingCutoff`;
   *   - `unavailable` rows checked before `unavailableCutoff`.
   * Cited ARKs come before uncited ones so the trust-critical documents (the
   * ones a note already quotes) converge first, then the oldest check.
   *
   * The one raw query of the model: Prisma cannot anti-join `document` (keyed
   * per project) to `document_ocr` (keyed per ARK), which share no relation.
   * The tagged template parameterizes every interpolation.
   */
  static async pendingOcrArks(opts: {
    limit: number
    buildingCutoff: Date
    unavailableCutoff: Date
  }): Promise<string[]> {
    const rows = await prisma.$queryRaw<Array<{ ark: string }>>`
      SELECT d.ark
      FROM (SELECT DISTINCT ark FROM document WHERE indexed_at IS NOT NULL) d
      LEFT JOIN document_ocr o ON o.ark = d.ark
      WHERE o.ark IS NULL
         OR (o.status = ${OCR_SYNC_STATUS.BUILDING} AND o.checked_at < ${opts.buildingCutoff})
         OR (o.status = ${OCR_SYNC_STATUS.UNAVAILABLE} AND o.checked_at < ${opts.unavailableCutoff})
      ORDER BY (o.ark IS NULL) DESC,
               EXISTS (SELECT 1 FROM citation c WHERE c.ark = d.ark) DESC,
               o.checked_at ASC NULLS FIRST,
               d.ark
      LIMIT ${opts.limit}
    `
    return rows.map((r) => r.ark)
  }

  /**
   * How many ARKs pendingOcrArks would offer with the same cutoffs (no limit) —
   * the `pending-left` of the sync cycle's progress log line.
   */
  static async countPendingOcrArks(opts: {
    buildingCutoff: Date
    unavailableCutoff: Date
  }): Promise<number> {
    const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n
      FROM (SELECT DISTINCT ark FROM document WHERE indexed_at IS NOT NULL) d
      LEFT JOIN document_ocr o ON o.ark = d.ark
      WHERE o.ark IS NULL
         OR (o.status = ${OCR_SYNC_STATUS.BUILDING} AND o.checked_at < ${opts.buildingCutoff})
         OR (o.status = ${OCR_SYNC_STATUS.UNAVAILABLE} AND o.checked_at < ${opts.unavailableCutoff})
    `
    if (row === undefined) throw new Error("countPendingOcrArks: COUNT returned no row")
    return Number(row.n)
  }

  /**
   * Whether `ark` is an INDEXED document of the corpus owned by
   * `corpusProjectId` — the D8 gate before rag_get_text reads an ARK's OCR
   * quality (only indexed documents have retrievable text). The documents/ocr
   * route and doc_get gate on the Document row itself (getByArk). Callers
   * resolve `corpusProjectId` through lib/authz/corpus-source.ts, never
   * ctx.projectId.
   */
  static async isIndexedInCorpus(corpusProjectId: string, ark: string): Promise<boolean> {
    const row = await prisma.document.findFirst({
      where: { projectId: corpusProjectId, ark, indexedAt: { not: null } },
      select: { ark: true },
    })
    return row !== null
  }
}
