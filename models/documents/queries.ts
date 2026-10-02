// models/documents/queries.ts
// Pure database access for the documents model.
// Imports only from @/lib/db and ./schema.
import "server-only"

import { prisma } from "@/lib/db"
import {
  type Document,
  documentFolioRow,
  documentOcrStatusRow,
  documentOcrWithFolios,
  type DocumentFolioRow,
  type DocumentOcrStatusRow,
  type DocumentOcrWithFolios,
  type FolioRef,
} from "./schema"

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
  // Every user-facing read takes the reader's CORPUS project (resolved through
  // lib/authz/corpus-source.ts) and only ever returns rows for ARKs that are
  // Documents of that corpus: no caller can turn the global table into an
  // oracle for another project's corpus, even one that forgot its own gate.
  // -------------------------------------------------------------------------

  /** The subset of `arks` that are Documents of the corpus. */
  private static async arksInCorpus(corpusProjectId: string, arks: string[]): Promise<string[]> {
    if (arks.length === 0) return []
    const rows = await prisma.document.findMany({
      where: { projectId: corpusProjectId, ark: { in: [...new Set(arks)] } },
      select: { ark: true },
    })
    return rows.map((r) => r.ark)
  }

  /**
   * The stored quality of the given (ark, folio) pairs plus the sync status of
   * their documents — the rows an OcrIndex is built from (lib/ocr/quality.ts).
   * PK-scoped. A pair with no stored folio is absent; an ARK with no status
   * row is pending; an ARK outside the corpus contributes nothing.
   */
  static async ocrIndexRows(
    corpusProjectId: string,
    refs: FolioRef[],
  ): Promise<{ folios: DocumentFolioRow[]; documents: DocumentOcrStatusRow[] }> {
    const allowed = new Set(
      await DocumentQueries.arksInCorpus(corpusProjectId, refs.map((r) => r.ark)),
    )
    const byArk = new Map<string, Set<number>>()
    for (const r of refs) {
      if (!allowed.has(r.ark)) continue
      const folios = byArk.get(r.ark) ?? new Set<number>()
      folios.add(r.folio)
      byArk.set(r.ark, folios)
    }
    if (byArk.size === 0) return { folios: [], documents: [] }
    const [folios, documents] = await Promise.all([
      prisma.documentFolio.findMany({
        where: {
          OR: [...byArk].map(([ark, folios]) => ({ ark, folio: { in: [...folios] } })),
        },
        ...documentFolioRow,
      }),
      prisma.documentOcr.findMany({
        where: { ark: { in: [...byArk.keys()] } },
        ...documentOcrStatusRow,
      }),
    ])
    return { folios, documents }
  }

  /**
   * A corpus document's OCR summary with every stored folio; null when the
   * document has no row yet (pending) or is not a Document of the corpus.
   * Callers that must tell those apart (a 404) check getByArk first.
   */
  static async ocrForArk(
    corpusProjectId: string,
    ark: string,
  ): Promise<DocumentOcrWithFolios | null> {
    const [allowed] = await DocumentQueries.arksInCorpus(corpusProjectId, [ark])
    if (allowed === undefined) return null
    return prisma.documentOcr.findUnique({ where: { ark }, ...documentOcrWithFolios })
  }

  /** The OCR summaries (with folios) of the given corpus documents; absent = pending. */
  static async ocrForArks(
    corpusProjectId: string,
    arks: string[],
  ): Promise<DocumentOcrWithFolios[]> {
    const allowed = await DocumentQueries.arksInCorpus(corpusProjectId, arks)
    if (allowed.length === 0) return []
    return prisma.documentOcr.findMany({
      where: { ark: { in: allowed } },
      ...documentOcrWithFolios,
    })
  }

  /**
   * The ARKs the OCR-quality sweep must ask the worker about — a SYSTEM read
   * (lib/documents/ocr-sync.ts), never exposed to a user. Every indexed ARK
   * (any project) that has no DocumentOcr row, or whose row is due
   * (`next_check_at <= now`: building / unavailable / backing off, or a
   * re-ingest's resync request). Never-asked and resync-requested ARKs come
   * first, then cited ones (the trust-critical documents a note already
   * quotes), then the longest-due.
   *
   * The one raw query of the model: Prisma cannot anti-join `document` (keyed
   * per project) to `document_ocr` (keyed per ARK), which share no relation.
   * The tagged template parameterizes every interpolation.
   */
  static async pendingOcrArks(opts: { limit: number; now: Date }): Promise<string[]> {
    const rows = await prisma.$queryRaw<Array<{ ark: string }>>`
      SELECT d.ark
      FROM (SELECT DISTINCT ark FROM document WHERE indexed_at IS NOT NULL) d
      LEFT JOIN document_ocr o ON o.ark = d.ark
      WHERE o.ark IS NULL OR o.next_check_at <= ${opts.now}
      ORDER BY (o.ark IS NULL OR o.resync_requested_at IS NOT NULL) DESC,
               EXISTS (SELECT 1 FROM citation c WHERE c.ark = d.ark) DESC,
               o.next_check_at ASC NULLS FIRST,
               d.ark
      LIMIT ${opts.limit}
    `
    return rows.map((r) => r.ark)
  }

  /** How many ARKs pendingOcrArks would offer (no limit) — the cycle log's `pending-left`. */
  static async countPendingOcrArks(opts: { now: Date }): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n
      FROM (SELECT DISTINCT ark FROM document WHERE indexed_at IS NOT NULL) d
      LEFT JOIN document_ocr o ON o.ark = d.ark
      WHERE o.ark IS NULL OR o.next_check_at <= ${opts.now}
    `
    const [row] = rows
    if (row === undefined) throw new Error("countPendingOcrArks: COUNT returned no row")
    return Number(row.n)
  }

  /** The sync bookkeeping of some ARKs (the drainer's contract-failure accounting). */
  static async ocrSyncAttempts(arks: string[]): Promise<Array<{ ark: string; syncAttempts: number }>> {
    if (arks.length === 0) return []
    return prisma.documentOcr.findMany({
      where: { ark: { in: arks } },
      select: { ark: true, syncAttempts: true },
    })
  }

  /**
   * Whether `ark` is an INDEXED document of the corpus owned by
   * `corpusProjectId` — the gate before rag_get_text reads an ARK's text and
   * OCR quality (only indexed documents have retrievable text). The
   * documents/ocr route and doc_get gate on the Document row itself
   * (getByArk). Callers resolve `corpusProjectId` through
   * lib/authz/corpus-source.ts, never ctx.projectId.
   */
  static async isIndexedInCorpus(corpusProjectId: string, ark: string): Promise<boolean> {
    const row = await prisma.document.findFirst({
      where: { projectId: corpusProjectId, ark, indexedAt: { not: null } },
      select: { ark: true },
    })
    return row !== null
  }
}
