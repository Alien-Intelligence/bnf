import "server-only"
// models/documents/queries.ts
// Pure database access for the documents model.
// Imports only from @/lib/db and ./schema.

import { prisma } from "@/lib/db"
import type { Prisma } from "@/lib/generated/prisma/client"
import {
  DOCUMENT_CANONICAL_STATUS,
  DOCUMENT_RESOLVE_STATUS,
  type Document,
  documentFolioRow,
  documentOcrStatusRow,
  documentOcrWithFolios,
  OCR_SYNC_STATUS,
  type DocumentFolioRow,
  type DocumentOcrStatusRow,
  type DocumentOcrWithFolios,
  type FolioRef,
} from "./schema"

/** The fields of a resolved Document a bare buffer row copies. */
const resolvedDocumentSelect = {
  projectId: true,
  ark: true,
  title: true,
  author: true,
  year: true,
  dateLabel: true,
  docType: true,
  lang: true,
  rawMetadata: true,
} satisfies Prisma.DocumentSelect

export type ResolvedDocumentRow = Prisma.DocumentGetPayload<{ select: typeof resolvedDocumentSelect }>

export class DocumentQueries {
  /** Members of a corpus version still waiting for cb→Gallica canonicalisation. */
  static async pendingCanonicalInVersion(versionId: string): Promise<number> {
    return prisma.corpusMembership.count({
      where: { versionId, document: { canonicalStatus: DOCUMENT_CANONICAL_STATUS.PENDING } },
    })
  }

  /** Every distinct non-null `lang` value stored (a few dozen at most). */
  static async distinctLangs(): Promise<string[]> {
    const rows = await prisma.document.findMany({
      where: { lang: { not: null } },
      distinct: ["lang"],
      select: { lang: true },
    })
    return rows.flatMap((r) => (r.lang !== null ? [r.lang] : []))
  }

  /** Rewrite one stored `lang` value to another everywhere. Returns the count. */
  static async replaceLang(from: string, to: string | null): Promise<number> {
    const { count } = await prisma.document.updateMany({ where: { lang: from }, data: { lang: to } })
    return count
  }

  /**
   * The RESOLVED documents among the given ARKs of each project — the metadata
   * a bare buffer row can copy at no BnF cost. One query; the caller bounds
   * the ARK lists (a batch).
   */
  static async resolvedAmong(
    arksByProject: ReadonlyMap<string, readonly string[]>,
  ): Promise<ResolvedDocumentRow[]> {
    if (arksByProject.size === 0) return []
    return prisma.document.findMany({
      where: {
        resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
        OR: [...arksByProject].map(([projectId, arks]) => ({ projectId, ark: { in: [...arks] } })),
      },
      select: resolvedDocumentSelect,
    })
  }

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
   * The corpus projects that have OCR-quality work due, with how much — the
   * sweep's work list (lib/documents/ocr-sync.ts). A SYSTEM read that returns
   * project ids and counts only, never an ARK or a quality: every ARK-level
   * read below is scoped to one corpus. An ARK indexed in several corpora is
   * counted in each; it is synced once, through whichever is drained first.
   *
   * Due = indexed in that corpus, and either no DocumentOcr row yet or a row
   * whose `next_check_at` has passed (pending, building, unavailable,
   * incompatible, backing off, or a re-ingest's resync request). `resync`
   * counts the due rows with a resync request that is not merely waiting for
   * a build (a `building` row keeps its request but never holds the drainer's
   * resync tier).
   */
  static async ocrPendingByCorpus(
    now: Date,
  ): Promise<Array<{ corpusProjectId: string; pending: number; resync: number }>> {
    const rows = await prisma.$queryRaw<Array<{ project_id: string; n: bigint; resync: bigint }>>`
      SELECT d.project_id, count(*) AS n,
             count(*) FILTER (
               WHERE o.resync_requested_at IS NOT NULL AND o.status <> ${OCR_SYNC_STATUS.BUILDING}
             ) AS resync
      FROM document d
      LEFT JOIN document_ocr o ON o.ark = d.ark
      WHERE d.indexed_at IS NOT NULL
        AND (o.ark IS NULL OR o.next_check_at <= ${now})
      GROUP BY d.project_id
      ORDER BY d.project_id
    `
    return rows.map((r) => ({
      corpusProjectId: r.project_id,
      pending: Number(r.n),
      resync: Number(r.resync),
    }))
  }

  /**
   * The due ARKs of ONE corpus (see ocrPendingByCorpus) with their outage
   * count: resync-requested first (not a `building` row), then never-answered
   * — no row, or a `pending` one (asked, the transport failed) — then the
   * ones a note already cites (the trust-critical documents), then the
   * longest-due. Never-answered ARKs keep ONE stable order (their
   * `next_check_at` is ignored) so a batch that failed on the transport is
   * asked again as the same batch, never spread over fresh ARKs.
   *
   * Raw SQL because Prisma cannot anti-join `document` (keyed per project) to
   * `document_ocr` (keyed per ARK), which share no relation. The tagged
   * template parameterizes every interpolation.
   */
  static async pendingOcrArks(opts: {
    corpusProjectId: string
    limit: number
    now: Date
  }): Promise<Array<{ ark: string; outageCount: number }>> {
    const rows = await prisma.$queryRaw<Array<{ ark: string; outage_count: number }>>`
      SELECT d.ark, COALESCE(o.outage_count, 0)::int AS outage_count
      FROM document d
      LEFT JOIN document_ocr o ON o.ark = d.ark
      WHERE d.project_id = ${opts.corpusProjectId}
        AND d.indexed_at IS NOT NULL
        AND (o.ark IS NULL OR o.next_check_at <= ${opts.now})
      ORDER BY COALESCE(o.resync_requested_at IS NOT NULL AND o.status <> ${OCR_SYNC_STATUS.BUILDING}, false) DESC,
               (o.ark IS NULL OR o.status = ${OCR_SYNC_STATUS.PENDING}) DESC,
               EXISTS (SELECT 1 FROM citation c WHERE c.ark = d.ark) DESC,
               CASE WHEN o.status = ${OCR_SYNC_STATUS.PENDING} THEN NULL ELSE o.next_check_at END
                 ASC NULLS FIRST,
               d.ark
      LIMIT ${opts.limit}
    `
    return rows.map((r) => ({ ark: r.ark, outageCount: r.outage_count }))
  }

  /**
   * The ARKs the drainer may ask as CONTROLS to prove the worker up
   * (lib/documents/ocr-sync.ts): up to `limit` answered `available`, with no
   * outage on record (a control that failed is an ordinary ARK again, never
   * re-used as a control while its outage stands), the most recently synced
   * first (their artifacts are the likeliest to be served); never one of
   * `exclude`. The drainer rotates among them. A system read: the ARKs are
   * only re-asked, never shown.
   */
  static async ocrControlArks(exclude: string[], limit: number): Promise<string[]> {
    const rows = await prisma.documentOcr.findMany({
      where: { status: OCR_SYNC_STATUS.AVAILABLE, outageCount: 0, ark: { notIn: exclude } },
      orderBy: [{ syncedAt: { sort: "desc", nulls: "last" } }, { ark: "asc" }],
      take: limit,
      select: { ark: true },
    })
    return rows.map((r) => r.ark)
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
