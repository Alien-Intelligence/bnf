/**
 * OCR quality in the agent's corpus tool results (feedback 2026-09-29 #7,
 * Track B, Phase 5).
 *
 * The model must see, deterministically, when a folio's text is poorly
 * recognised: `ocrLow` is computed by code (isLowOcr, lib/ocr/quality.ts) and a
 * factual notice rides along whenever anything in a result is low. And it must
 * never mistake "not known" for "fine": every folio carries an explicit
 * `ocrState` (FOLIO_OCR_STATE, models/documents/schema.ts; its meanings as
 * the model reads them are FOLIO_OCR_STATE_MEANING in ./constants). Only
 * `recorded` carries ocrSource / ocrQuality; every other state leaves them
 * null, and ocrLow false.
 *
 * Gating (plan D8): every read takes the turn's corpus project and only ever
 * returns rows for Documents of that corpus (DocumentQueries); a reader whose
 * corpus grant was revoked reads nothing (OCR_INDEX_REVOKED). Every database
 * await is bounded by OCR_DB_TIMEOUT_MS and tied to the turn's signal; a
 * failure throws, and the chat-sdk turns it into an isError tool result — the
 * model sees the failure instead of a silently unannotated result. The note
 * write tools catch it instead (a committed write must never read as failed).
 */
import "server-only"

import { withDeadline } from "@/lib/async/deadline"
import { classifyFolioRefs, foliosInSlice } from "@/lib/citations/ocr"
import { parseCitations } from "@/lib/citations/syntax"
import type { RagKeywordHit, RagPassage } from "@/lib/cluster/rag"
import { OCR_DB_TIMEOUT_MS, RAG_OCR_LOW_FOLIOS_MAX } from "@/lib/constants"
import {
  OCR_INDEX_REVOKED,
  buildOcrIndex,
  folioOcrState,
  toDocumentOcrView,
  type FolioOcrState,
  type OcrIndex,
  type OcrReader,
  type UnknownFolioOcrState,
} from "@/lib/ocr/quality"
import { DocumentQueries } from "@/models/documents/queries"
import {
  DOCUMENT_OCR_STATUS,
  FOLIO_OCR_STATE,
  OCR_SOURCE,
  type DocumentOcrStatus,
  type DocumentOcrView,
  type FolioOcrStateKind,
  type FolioRef,
  type OcrSource,
} from "@/models/documents/schema"

import { RAG_KEYWORD_OCR_LOW_NOTICE, RAG_OCR_LOW_NOTICE } from "./constants"

/** The OCR fields one folio contributes to a tool result. */
export type FolioOcrFields = {
  /** The folio's state (FOLIO_OCR_STATE — see the header). */
  ocrState: FolioOcrStateKind
  /** Mean ALTO word confidence in [0, 1]; null unless recorded and scored. */
  ocrQuality: number | null
  /** What produced the text; null unless recorded. */
  ocrSource: OcrSource | null
  /** Computed by code: the folio's text is poorly recognised. */
  ocrLow: boolean
}

function folioFields(state: FolioOcrState): FolioOcrFields {
  if (state.kind === FOLIO_OCR_STATE.RECORDED) {
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

/**
 * A document's OCR summary. The folio counts are only TRUE when the document
 * is `available` (its folio list is complete): under any other status they are
 * null — unknown, never 0 — and `status` says why (DOCUMENT_OCR_STATUS_MEANING).
 */
export type DocOcrSummary = {
  status: DocumentOcrStatus
  /** The manifest "Taux OCR" / 100; null when BnF publishes none or not synced. */
  ocrRate: number | null
  /** Folios carrying a measured quality; null unless available. */
  scoredFolios: number | null
  /** Low folio numbers, ascending, capped at RAG_OCR_LOW_FOLIOS_MAX; null unless available. */
  lowFolios: number[] | null
  /** Exact number of low folios (lowFolios may be capped); null unless available. */
  lowFolioCount: number | null
}

export function docOcrSummary(view: DocumentOcrView): DocOcrSummary {
  if (view.status !== DOCUMENT_OCR_STATUS.AVAILABLE) {
    return {
      status: view.status,
      ocrRate: view.ocrRate,
      scoredFolios: null,
      lowFolios: null,
      lowFolioCount: null,
    }
  }
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
  /** The document's sync status: only `available` means the folio list is known. */
  ocrStatus: DocumentOcrStatus
  ocrRate: number | null
  /** null unless ocrStatus is `available` (unknown, never "none"). */
  ocrLowFolios: number[] | null
  /** null unless ocrStatus is `available` (unknown, never 0). */
  ocrLowFolioCount: number | null
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
    ...noticeIf(
      annotated.some((h) => h.ocrLowFolioCount !== null && h.ocrLowFolioCount > 0),
      RAG_KEYWORD_OCR_LOW_NOTICE,
    ),
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

/** A cited folio whose quality is not known — never to be read as "not low". */
export type UnknownOcrCitation = {
  ark: string
  folio: number
  ocr_state: UnknownFolioOcrState["kind"]
}

export type NoteOcrReport = {
  low: LowOcrCitation[]
  unknown: UnknownOcrCitation[]
}

/**
 * Some cited folios split into low and unknown (classifyFolioRefs — the one
 * classifier), one entry per (ark, folio), in first-seen order. The refs are
 * a note's Citation rows (a read) or its body's corpus-vouched text citations
 * (a write, noteCitationRefs).
 */
export function noteOcrReport(
  refs: Array<{ ark: string; folio: number | null }>,
  index: OcrIndex,
): NoteOcrReport {
  const { low, unknown } = classifyFolioRefs(refs, index)
  return {
    low: low.flatMap((f) =>
      f.view.ocrQuality === null ? [] : [{ ark: f.ark, folio: f.folio, ocr_quality: f.view.ocrQuality }],
    ),
    unknown: unknown.map((f) => ({ ark: f.ark, folio: f.folio, ocr_state: f.state.kind })),
  }
}

/**
 * The text citations of a body that the corpus vouched for, as folio refs.
 * `rejected` are the ARKs the corpus could not vouch for (NoteService): they
 * have no Citation row and are never looked up. Image embeds are not text
 * citations (D11).
 */
export function noteCitationRefs(body: string, rejected: string[]): FolioRef[] {
  const excluded = new Set(rejected)
  return parseCitations(body)
    .filter((c) => !excluded.has(c.ark))
    .map((c) => ({ ark: c.ark, folio: c.folio }))
}

// ---------------------------------------------------------------------------
// Loaders — corpus-gated, bounded, tied to the turn's signal
// ---------------------------------------------------------------------------

/**
 * The stored quality of the given folios on the reader's corpus, as an
 * OcrIndex — OCR_INDEX_REVOKED, without any read, when the reader's corpus
 * grant was revoked.
 */
export async function loadOcrIndex(reader: OcrReader, refs: FolioRef[]): Promise<OcrIndex> {
  if (!reader.corpusReachable) return OCR_INDEX_REVOKED
  const rows = await withDeadline(DocumentQueries.ocrIndexRows(reader.corpusProjectId, refs), {
    label: "OCR quality read",
    ms: OCR_DB_TIMEOUT_MS,
    signal: reader.signal,
  })
  return buildOcrIndex(rows.folios, rows.documents)
}

/**
 * A document-level OCR read was attempted for a reader whose corpus grant was
 * revoked. The handlers answer the revocation BEFORE any read
 * (resolveIngestedCorpus / doc_get's check); this is the loaders' own guard,
 * so a new caller cannot forget it.
 */
export class CorpusRevokedReadError extends Error {
  constructor(readonly corpusProjectId: string) {
    super(`OCR read on corpus ${corpusProjectId} through a revoked grant`)
    this.name = "CorpusRevokedReadError"
  }
}

/** The OCR summaries of the given corpus ARKs, indexed by ARK (absent = pending). */
export async function loadDocOcrIndex(reader: OcrReader, arks: string[]): Promise<Map<string, DocumentOcrView>> {
  if (!reader.corpusReachable) throw new CorpusRevokedReadError(reader.corpusProjectId)
  const rows = await withDeadline(DocumentQueries.ocrForArks(reader.corpusProjectId, arks), {
    label: "OCR quality read",
    ms: OCR_DB_TIMEOUT_MS,
    signal: reader.signal,
  })
  return new Map(rows.map((r) => [r.ark, toDocumentOcrView(r.ark, r)]))
}

/** One corpus document's OCR summary (pending when no row). */
export async function loadDocOcrSummary(reader: OcrReader, ark: string): Promise<DocOcrSummary> {
  if (!reader.corpusReachable) throw new CorpusRevokedReadError(reader.corpusProjectId)
  const row = await withDeadline(DocumentQueries.ocrForArk(reader.corpusProjectId, ark), {
    label: "OCR quality read",
    ms: OCR_DB_TIMEOUT_MS,
    signal: reader.signal,
  })
  return docOcrSummary(toDocumentOcrView(ark, row))
}
