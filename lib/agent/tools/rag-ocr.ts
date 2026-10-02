/**
 * OCR quality in the agent's corpus tool results (feedback 2026-09-29 #7,
 * Track B, Phase 5).
 *
 * The model must see, deterministically, when a folio's text is poorly
 * recognised: `ocrLow` is computed by code (isLowOcr, lib/ocr/quality.ts) and a
 * factual notice rides along whenever anything in a result is low. And it must
 * never mistake "not known" for "fine": every folio carries an explicit
 * `ocrState` (the four states of lib/ocr/quality.ts):
 *   recorded     — ocrSource / ocrQuality / ocrLow are the stored values;
 *   not_synced   — the document's quality is not stored yet (or not
 *                  obtainable); ocrSource and ocrQuality are null;
 *   not_recorded — the document is synced but this folio has no stored row;
 *   no_folio     — the passage itself carries no folio.
 *
 * Gating (plan D8): every read takes the turn's corpus project and only ever
 * returns rows for Documents of that corpus (DocumentQueries). Every database
 * await is bounded by OCR_DB_TIMEOUT_MS and tied to the turn's signal; a
 * failure throws, and the chat-sdk turns it into an isError tool result — the
 * model sees the failure instead of a silently unannotated result. The note
 * write tools catch it instead (a committed write must never read as failed).
 */
import "server-only"

import { withDeadline } from "@/lib/async/deadline"
import { citationOcrSummary, foliosInSlice } from "@/lib/citations/ocr"
import { parseCitations } from "@/lib/citations/syntax"
import type { RagKeywordHit, RagPassage } from "@/lib/cluster/rag"
import { OCR_DB_TIMEOUT_MS, RAG_OCR_LOW_FOLIOS_MAX } from "@/lib/constants"
import {
  buildOcrIndex,
  folioOcrKey,
  folioOcrState,
  toDocumentOcrView,
  type FolioOcrState,
  type OcrIndex,
} from "@/lib/ocr/quality"
import { DocumentQueries } from "@/models/documents/queries"
import {
  OCR_SOURCE,
  type DocumentOcrStatus,
  type DocumentOcrView,
  type FolioRef,
  type OcrSource,
} from "@/models/documents/schema"

import { RAG_KEYWORD_OCR_LOW_NOTICE, RAG_OCR_LOW_NOTICE } from "./constants"

/** The OCR fields one folio contributes to a tool result. */
export type FolioOcrFields = {
  /** Which of the four states the folio is in (see the header). */
  ocrState: FolioOcrState["kind"]
  /** Mean ALTO word confidence in [0, 1]; null unless recorded and scored. */
  ocrQuality: number | null
  /** What produced the text; null unless recorded. */
  ocrSource: OcrSource | null
  /** Computed by code: the folio's text is poorly recognised. */
  ocrLow: boolean
}

function folioFields(state: FolioOcrState): FolioOcrFields {
  if (state.kind === "recorded") {
    return {
      ocrState: state.kind,
      ocrQuality: state.view.ocrQuality,
      ocrSource: state.view.ocrSource,
      ocrLow: state.view.low,
    }
  }
  return { ocrState: state.kind, ocrQuality: null, ocrSource: null, ocrLow: false }
}

/** `{ocrNotice}` when anything in the result is low, otherwise nothing. */
function noticeIf(anyLow: boolean, notice: string): { ocrNotice?: string } {
  return anyLow ? { ocrNotice: notice } : {}
}

// ---------------------------------------------------------------------------
// rag_query
// ---------------------------------------------------------------------------

export type OcrAnnotatedPassage = RagPassage & FolioOcrFields

export function annotatePassages(
  passages: RagPassage[],
  index: OcrIndex,
): { passages: OcrAnnotatedPassage[]; ocrNotice?: string } {
  const annotated = passages.map((p) => ({
    ...p,
    ...folioFields(folioOcrState(index, p.ark, p.folio)),
  }))
  return { passages: annotated, ...noticeIf(annotated.some((p) => p.ocrLow), RAG_OCR_LOW_NOTICE) }
}

// ---------------------------------------------------------------------------
// doc_get / rag_keyword_search — a document's OCR summary
// ---------------------------------------------------------------------------

export type DocOcrSummary = {
  status: DocumentOcrStatus
  /** The manifest "Taux OCR" / 100; null when BnF publishes none or not synced. */
  ocrRate: number | null
  /** Folios carrying a measured quality. */
  scoredFolios: number
  /** Low folio numbers, ascending, capped at RAG_OCR_LOW_FOLIOS_MAX. */
  lowFolios: number[]
  /** Exact number of low folios (lowFolios may be capped). */
  lowFolioCount: number
}

export function docOcrSummary(view: DocumentOcrView): DocOcrSummary {
  const low = view.folios.filter((f) => f.low).map((f) => f.folio).sort((a, b) => a - b)
  return {
    status: view.status,
    ocrRate: view.ocrRate,
    scoredFolios: view.folios.filter(
      (f) => f.ocrSource === OCR_SOURCE.ALTO && f.ocrQuality !== null,
    ).length,
    lowFolios: low.slice(0, RAG_OCR_LOW_FOLIOS_MAX),
    lowFolioCount: low.length,
  }
}

export type OcrAnnotatedKeywordHit = RagKeywordHit & {
  /** The document's sync status: only `available` means the folio list is complete. */
  ocrStatus: DocumentOcrStatus
  ocrRate: number | null
  ocrLowFolios: number[]
  ocrLowFolioCount: number
}

export function annotateKeywordHits(
  hits: RagKeywordHit[],
  docIndex: Map<string, DocumentOcrView>,
): { hits: OcrAnnotatedKeywordHit[]; ocrNotice?: string } {
  const annotated = hits.map((h) => {
    const summary = docOcrSummary(docIndex.get(h.ark) ?? toDocumentOcrView(h.ark, null))
    return {
      ...h,
      ocrStatus: summary.status,
      ocrRate: summary.ocrRate,
      ocrLowFolios: summary.lowFolios,
      ocrLowFolioCount: summary.lowFolioCount,
    }
  })
  return {
    hits: annotated,
    ...noticeIf(annotated.some((h) => h.ocrLowFolioCount > 0), RAG_KEYWORD_OCR_LOW_NOTICE),
  }
}

// ---------------------------------------------------------------------------
// rag_get_text
// ---------------------------------------------------------------------------

export type TextSliceOcr = {
  /** False when the slice starts mid-folio: that leading folio is unknown, never guessed. */
  leadingFolioKnown: boolean
  /** Each folio whose `## Folio N` heading falls inside the slice, in slice order. */
  folios: Array<{ folio: number } & FolioOcrFields>
}

export function annotateTextSlice(
  text: string,
  ark: string,
  index: OcrIndex,
): { ocr: TextSliceOcr; ocrNotice?: string } {
  const { folios, leadingFolioKnown } = foliosInSlice(text)
  const annotated = folios.map((folio) => ({
    folio,
    ...folioFields(folioOcrState(index, ark, folio)),
  }))
  return {
    ocr: { leadingFolioKnown, folios: annotated },
    ...noticeIf(annotated.some((f) => f.ocrLow), RAG_OCR_LOW_NOTICE),
  }
}

// ---------------------------------------------------------------------------
// note_create / note_update / note_append / note_get / note_list
// ---------------------------------------------------------------------------

/** A cited folio measured below the threshold (a low folio is always scored). */
export type LowOcrCitation = { ark: string; folio: number; ocr_quality: number }

/** A cited folio whose quality is not available — never to be read as "not low". */
export type UnknownOcrCitation = {
  ark: string
  folio: number
  ocr_state: "not_synced" | "not_recorded"
}

export type NoteOcrReport = {
  low: LowOcrCitation[]
  unknown: UnknownOcrCitation[]
}

/**
 * The note's text citations split into low and unknown, one entry per
 * (ark, folio), in body order. `rejected` are the ARKs the corpus could not
 * vouch for (NoteService): they have no Citation row and are never reported.
 * Image embeds are excluded (D11, citationOcrSummary).
 */
export function noteOcrReport(body: string, index: OcrIndex, rejected: string[]): NoteOcrReport {
  const excluded = new Set(rejected)
  const { low, unknown } = citationOcrSummary(body, index)
  const report: NoteOcrReport = { low: [], unknown: [] }
  const seen = new Set<string>()
  for (const c of [...low, ...unknown]) {
    const key = folioOcrKey(c.ark, c.folio)
    if (excluded.has(c.ark) || seen.has(key)) continue
    seen.add(key)
    const state = folioOcrState(index, c.ark, c.folio)
    if (state.kind === "recorded" && state.view.ocrQuality !== null) {
      report.low.push({ ark: c.ark, folio: c.folio, ocr_quality: state.view.ocrQuality })
    } else if (state.kind === "not_synced" || state.kind === "not_recorded") {
      report.unknown.push({ ark: c.ark, folio: c.folio, ocr_state: state.kind })
    }
  }
  return report
}

/** The text citations of a body that the corpus vouched for, as folio refs. */
export function noteCitationRefs(body: string, rejected: string[]): FolioRef[] {
  const excluded = new Set(rejected)
  return parseCitations(body)
    .filter((c) => !excluded.has(c.ark))
    .map((c) => ({ ark: c.ark, folio: c.folio }))
}

// ---------------------------------------------------------------------------
// Loaders — corpus-gated, bounded, tied to the turn's signal
// ---------------------------------------------------------------------------

/** The stored quality of the given folios on the turn's corpus, as an OcrIndex. */
export async function loadOcrIndex(
  corpusProjectId: string,
  refs: FolioRef[],
  signal: AbortSignal,
): Promise<OcrIndex> {
  const rows = await withDeadline(DocumentQueries.ocrIndexRows(corpusProjectId, refs), {
    label: "OCR quality read",
    ms: OCR_DB_TIMEOUT_MS,
    signal,
  })
  return buildOcrIndex(rows.folios, rows.documents)
}

/** The OCR summaries of the given corpus ARKs, indexed by ARK (absent = pending). */
export async function loadDocOcrIndex(
  corpusProjectId: string,
  arks: string[],
  signal: AbortSignal,
): Promise<Map<string, DocumentOcrView>> {
  const rows = await withDeadline(DocumentQueries.ocrForArks(corpusProjectId, arks), {
    label: "OCR quality read",
    ms: OCR_DB_TIMEOUT_MS,
    signal,
  })
  return new Map(rows.map((r) => [r.ark, toDocumentOcrView(r.ark, r)]))
}

/** One corpus document's OCR summary (pending when no row). */
export async function loadDocOcrSummary(
  corpusProjectId: string,
  ark: string,
  signal: AbortSignal,
): Promise<DocOcrSummary> {
  const row = await withDeadline(DocumentQueries.ocrForArk(corpusProjectId, ark), {
    label: "OCR quality read",
    ms: OCR_DB_TIMEOUT_MS,
    signal,
  })
  return docOcrSummary(toDocumentOcrView(ark, row))
}
