// lib/ocr/quality.ts
// The OCR-quality read model (feedback 2026-09-29 #7, Track B): THE "low"
// decision, the stored-row → view mappings, and the per-folio state every
// reader (agent tools, pills, banner, side panel, exports) uses. Pure and
// client-safe.
//
// A folio's OCR quality is one of four states, never collapsed:
//   no_folio     — the reference carries no folio at all;
//   not_synced   — the document's quality is not stored (pending, building,
//                  unavailable or quarantined);
//   not_recorded — the document is synced but this folio has no stored row
//                  (not a prepared page of it);
//   recorded     — the stored view, which may be low, not low, or unscored.

import { OCR_LOW_QUALITY_THRESHOLD } from "@/lib/constants"
import {
  OCR_STATUS_PENDING,
  OCR_SYNC_STATUS,
  OCR_SOURCE,
  type DocumentFolioRow,
  type DocumentOcrStatus,
  type DocumentOcrStatusRow,
  type DocumentOcrView,
  type DocumentOcrWithFolios,
  type FolioOcrView,
  type OcrSource,
  type OcrSyncStatus,
} from "@/models/documents/schema"

const OCR_SOURCES = new Set<string>(Object.values(OCR_SOURCE))
const OCR_SYNC_STATUSES = new Set<string>(Object.values(OCR_SYNC_STATUS))

function isOcrSource(v: string): v is OcrSource {
  return OCR_SOURCES.has(v)
}

function isOcrSyncStatus(v: string): v is OcrSyncStatus {
  return OCR_SYNC_STATUSES.has(v)
}

/** A stored DocumentOcr.status, validated: an unknown value is a corrupt row and throws. */
export function toOcrSyncStatus(ark: string, raw: string): OcrSyncStatus {
  if (!isOcrSyncStatus(raw)) {
    throw new Error(`document_ocr ${ark}: unknown status "${raw}"`)
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
 * throws rather than being read as "not low".
 */
export function toFolioOcrView(row: DocumentFolioRow): FolioOcrView {
  if (!isOcrSource(row.ocrSource)) {
    throw new Error(
      `document_folio ${row.ark} f${row.folio}: unknown ocr_source "${row.ocrSource}"`,
    )
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
    return { ark, status: OCR_STATUS_PENDING, ocrRate: null, reason: null, folios: [] }
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

/** The stored quality of some folios plus the sync status of their documents. */
export type OcrIndex = {
  folios: Map<string, FolioOcrView>
  /** Stored status per ARK; an ARK absent from the map is pending. */
  documents: Map<string, OcrSyncStatus>
}

export function buildOcrIndex(
  folioRows: DocumentFolioRow[],
  statusRows: DocumentOcrStatusRow[],
): OcrIndex {
  return {
    folios: new Map(folioRows.map((r) => [folioOcrKey(r.ark, r.folio), toFolioOcrView(r)])),
    documents: new Map(statusRows.map((r) => [r.ark, toOcrSyncStatus(r.ark, r.status)])),
  }
}

/** The document-level status of an ARK in an index (pending when unknown). */
export function documentOcrStatus(index: OcrIndex, ark: string): DocumentOcrStatus {
  return index.documents.get(ark) ?? OCR_STATUS_PENDING
}

export type FolioOcrState =
  | { kind: "no_folio" }
  | { kind: "not_synced"; status: DocumentOcrStatus }
  | { kind: "not_recorded" }
  | { kind: "recorded"; view: FolioOcrView }

/** Classify one (ark, folio) reference against an index — see the header. */
export function folioOcrState(index: OcrIndex, ark: string, folio: number | null): FolioOcrState {
  if (folio === null) return { kind: "no_folio" }
  const view = index.folios.get(folioOcrKey(ark, folio))
  if (view !== undefined) return { kind: "recorded", view }
  const status = documentOcrStatus(index, ark)
  if (status === OCR_SYNC_STATUS.AVAILABLE) return { kind: "not_recorded" }
  return { kind: "not_synced", status }
}
