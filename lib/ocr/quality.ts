// lib/ocr/quality.ts
// The OCR-quality read model (feedback 2026-09-29 #7, Track B): THE "low"
// decision, the stored-row → view mappings, and the per-folio state every
// reader (agent tools, pills, banner, side panel, exports) uses. Pure and
// client-safe.
//
// A folio's OCR quality is one of the FOLIO_OCR_STATE kinds
// (models/documents/schema.ts), never collapsed: "not known" is never "fine",
// "not yet" is never "never", and "you may no longer read it" is neither.

import { OCR_LOW_QUALITY_THRESHOLD } from "@/lib/constants"
import {
  DOCUMENT_OCR_STATUS,
  FOLIO_OCR_STATE,
  OCR_ACCESS,
  OCR_SYNC_STATUS,
  OCR_SOURCE,
  type DocumentFolioRow,
  type DocumentOcrStatus,
  type DocumentOcrStatusRow,
  type DocumentOcrView,
  type DocumentOcrWithFolios,
  type FolioOcrView,
  type NoteOcrRows,
  type OcrSource,
  type OcrSyncStatus,
} from "@/models/documents/schema"

/**
 * A stored OCR row holds a value outside its closed vocabulary. The rows are
 * written only from Zod-validated worker responses, so this is corruption (or
 * a schema drift between deploys): it is raised, never read as "not low".
 */
export class CorruptOcrRowError extends Error {
  readonly table: "document_ocr" | "document_folio"
  readonly ark: string
  readonly column: string
  readonly value: string

  constructor(args: {
    table: "document_ocr" | "document_folio"
    ark: string
    folio?: number
    column: string
    value: string
  }) {
    const where = args.folio === undefined ? args.ark : `${args.ark} f${args.folio}`
    super(`${args.table} ${where}: unknown ${args.column} "${args.value}"`)
    this.name = "CorruptOcrRowError"
    this.table = args.table
    this.ark = args.ark
    this.column = args.column
    this.value = args.value
  }
}

const OCR_SOURCES = new Set<string>(Object.values(OCR_SOURCE))
const OCR_SYNC_STATUSES = new Set<string>(Object.values(OCR_SYNC_STATUS))

function isOcrSource(v: string): v is OcrSource {
  return OCR_SOURCES.has(v)
}

function isOcrSyncStatus(v: string): v is OcrSyncStatus {
  return OCR_SYNC_STATUSES.has(v)
}

/** A stored DocumentOcr.status, validated: an unknown value raises CorruptOcrRowError. */
export function toOcrSyncStatus(ark: string, raw: string): OcrSyncStatus {
  if (!isOcrSyncStatus(raw)) {
    throw new CorruptOcrRowError({ table: "document_ocr", ark, column: "status", value: raw })
  }
  return raw
}

/**
 * THE "low" decision (plan D10): a measured quality strictly below
 * OCR_LOW_QUALITY_THRESHOLD. An unscored folio (null — non-ALTO source, ALTO
 * without WC) is never low. Computed at read time, never stored.
 */
export function isLowOcr(ocrQuality: number | null): boolean {
  return ocrQuality !== null && ocrQuality < OCR_LOW_QUALITY_THRESHOLD
}

/** A [0, 1] quality or rate as the whole percentage every surface shows (0.661 → 66). */
export function ocrPercent(fraction: number): number {
  return Math.round(fraction * 100)
}

/**
 * Stored row → view. The source column is a closed vocabulary written only from
 * a Zod-validated worker response, so an unknown value is a corrupt row: it
 * raises CorruptOcrRowError rather than being read as "not low".
 */
export function toFolioOcrView(row: DocumentFolioRow): FolioOcrView {
  if (!isOcrSource(row.ocrSource)) {
    throw new CorruptOcrRowError({
      table: "document_folio",
      ark: row.ark,
      folio: row.folio,
      column: "ocr_source",
      value: row.ocrSource,
    })
  }
  return {
    ark: row.ark,
    folio: row.folio,
    ocrSource: row.ocrSource,
    ocrQuality: row.ocrQuality,
    wordCount: row.wordCount,
    low: isLowOcr(row.ocrQuality),
  }
}

/**
 * Stored row (or its absence) → view. No row is `pending`. Folios are kept
 * whatever the status: a `building` row that was once `available` still holds
 * valid folios until the next artifact replaces them.
 */
export function toDocumentOcrView(
  ark: string,
  row: DocumentOcrWithFolios | null,
): DocumentOcrView {
  if (row === null) {
    return { ark, status: DOCUMENT_OCR_STATUS.PENDING, ocrRate: null, reason: null, folios: [] }
  }
  return {
    ark: row.ark,
    status: toOcrSyncStatus(row.ark, row.status),
    ocrRate: row.ocrRate,
    reason: row.reason,
    folios: row.folios.map(toFolioOcrView).sort((a, b) => a.folio - b.folio),
  }
}

/** Map key of one (ark, folio). */
export function folioOcrKey(ark: string, folio: number): string {
  return `${ark}#${folio}`
}

/**
 * What a reader may know of some folios: the stored quality of the folios
 * plus the sync status of their documents — or why nothing may be read (a
 * revoked corpus grant, a failed read). A reader holding a non-ok index
 * classifies every folio as that state, never as "not low".
 */
export type OcrIndex =
  | {
      access: typeof OCR_ACCESS.OK
      folios: Map<string, FolioOcrView>
      /** Stored status per ARK; an ARK absent from the map is pending. */
      documents: Map<string, OcrSyncStatus>
    }
  | { access: typeof OCR_ACCESS.CORPUS_REVOKED }
  | { access: typeof OCR_ACCESS.CHECK_FAILED }

/** The index of a reader whose corpus grant was revoked: no OCR row is read. */
export const OCR_INDEX_REVOKED: OcrIndex = { access: OCR_ACCESS.CORPUS_REVOKED }
/** The index of a reader whose OCR read failed: the quality is not known. */
export const OCR_INDEX_CHECK_FAILED: OcrIndex = { access: OCR_ACCESS.CHECK_FAILED }

export function buildOcrIndex(
  folioRows: DocumentFolioRow[],
  statusRows: DocumentOcrStatusRow[],
): OcrIndex {
  return {
    access: OCR_ACCESS.OK,
    folios: new Map(folioRows.map((r) => [folioOcrKey(r.ark, r.folio), toFolioOcrView(r)])),
    documents: new Map(statusRows.map((r) => [r.ark, toOcrSyncStatus(r.ark, r.status)])),
  }
}

/** A note's OCR rows (NoteDetail.ocr) as an index. */
export function noteOcrIndex(rows: NoteOcrRows): OcrIndex {
  if (rows.access === OCR_ACCESS.CORPUS_REVOKED) return OCR_INDEX_REVOKED
  if (rows.access === OCR_ACCESS.CHECK_FAILED) return OCR_INDEX_CHECK_FAILED
  return buildOcrIndex(rows.folioOcr, rows.documentOcr)
}

export type FolioOcrState =
  | { kind: typeof FOLIO_OCR_STATE.RECORDED; view: FolioOcrView }
  | {
      kind: typeof FOLIO_OCR_STATE.PENDING
      /** "Not yet": no row, or a sync in flight. */
      status: typeof DOCUMENT_OCR_STATUS.PENDING | typeof DOCUMENT_OCR_STATUS.BUILDING
    }
  | {
      kind: typeof FOLIO_OCR_STATE.UNAVAILABLE
      /** Not obtained, maybe never: the worker could not, or the sync was quarantined. */
      status: typeof DOCUMENT_OCR_STATUS.UNAVAILABLE | typeof DOCUMENT_OCR_STATUS.QUARANTINED
    }
  | { kind: typeof FOLIO_OCR_STATE.NOT_RECORDED }
  | { kind: typeof FOLIO_OCR_STATE.NO_FOLIO }
  | { kind: typeof FOLIO_OCR_STATE.CORPUS_REVOKED }
  | { kind: typeof FOLIO_OCR_STATE.CHECK_FAILED }

/** Classify one (ark, folio) reference against an index — see FOLIO_OCR_STATE. */
export function folioOcrState(index: OcrIndex, ark: string, folio: number | null): FolioOcrState {
  if (folio === null) return { kind: FOLIO_OCR_STATE.NO_FOLIO }
  if (index.access === OCR_ACCESS.CORPUS_REVOKED) return { kind: FOLIO_OCR_STATE.CORPUS_REVOKED }
  if (index.access === OCR_ACCESS.CHECK_FAILED) return { kind: FOLIO_OCR_STATE.CHECK_FAILED }
  const view = index.folios.get(folioOcrKey(ark, folio))
  if (view !== undefined) return { kind: FOLIO_OCR_STATE.RECORDED, view }
  const status: DocumentOcrStatus = index.documents.get(ark) ?? DOCUMENT_OCR_STATUS.PENDING
  if (status === DOCUMENT_OCR_STATUS.AVAILABLE) return { kind: FOLIO_OCR_STATE.NOT_RECORDED }
  if (status === DOCUMENT_OCR_STATUS.PENDING || status === DOCUMENT_OCR_STATUS.BUILDING) {
    return { kind: FOLIO_OCR_STATE.PENDING, status }
  }
  return { kind: FOLIO_OCR_STATE.UNAVAILABLE, status }
}

/** A folio state whose quality is not known to the reader. */
export type UnknownFolioOcrState = Exclude<
  FolioOcrState,
  { kind: typeof FOLIO_OCR_STATE.RECORDED } | { kind: typeof FOLIO_OCR_STATE.NO_FOLIO }
>

/**
 * Whether a folio's quality is UNKNOWN to the reader — everything but a
 * recorded row and a reference without a folio. An unknown folio is never
 * shown or reported as "not low".
 */
export function isOcrUnknown(state: FolioOcrState): state is UnknownFolioOcrState {
  return state.kind !== FOLIO_OCR_STATE.RECORDED && state.kind !== FOLIO_OCR_STATE.NO_FOLIO
}

/**
 * Who reads OCR rows, and whether they still may: the corpus a reader's
 * citations come from (the source's, for a derived workspace), whether its
 * grant still holds, and the signal its bounded reads are tied to. A turn
 * context and a route both supply one; a revoked reader reads no OCR row.
 */
export type OcrReader = {
  corpusProjectId: string
  corpusReachable: boolean
  signal: AbortSignal
}
