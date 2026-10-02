/**
 * OCR quality in the agent's corpus-text tool results (feedback 2026-09-29 #7,
 * Track B, Phase 5).
 *
 * The model must see, deterministically, when a folio's text is poorly
 * recognised: `ocrLow` is computed by code (isLowOcr, models/documents/schema.ts)
 * and a factual notice rides along whenever anything in a result is low. Pure
 * annotators (tested in rag-ocr.test.ts) plus the two loaders that read the
 * stored quality.
 *
 * Vocabulary: `ocrSource: null` means "quality not synced yet" (no stored
 * folio). It is distinct from a real source with a null score (a mistral or
 * vision page, or an ALTO page without WC) — neither is ever low.
 *
 * Gating (plan D8): the stored quality is global per ARK, so every caller
 * passes only ARKs it already holds for this corpus — passages and hits from
 * the project's own RAG dataset, a corpus-checked rag_get_text ARK, or a note's
 * corpus-validated citations.
 */
import "server-only"

import { RAG_OCR_LOW_FOLIOS_MAX } from "@/lib/constants"
import { folioOcrKey, foliosInSlice, indexFolioOcr } from "@/lib/citations/ocr"
import { parseCitations } from "@/lib/citations/syntax"
import type { RagKeywordHit, RagPassage } from "@/lib/cluster/rag"
import { DocumentQueries, type FolioRef } from "@/models/documents/queries"
import {
  OCR_SOURCE,
  toDocumentOcrView,
  toFolioOcrView,
  type DocumentOcrStatus,
  type DocumentOcrView,
  type FolioOcrView,
  type OcrSource,
} from "@/models/documents/schema"

import { RAG_OCR_LOW_NOTICE } from "./constants"

/** The OCR fields one folio contributes to a tool result. */
export type FolioOcrFields = {
  /** Mean ALTO word confidence in [0, 1]; null when unscored or not synced. */
  ocrQuality: number | null
  /** What produced the text; null = quality not synced yet. */
  ocrSource: OcrSource | null
  /** Computed by code: the folio's text is poorly recognised. */
  ocrLow: boolean
}

const NOT_SYNCED: FolioOcrFields = { ocrQuality: null, ocrSource: null, ocrLow: false }

function folioFields(view: FolioOcrView | undefined): FolioOcrFields {
  if (view === undefined) return NOT_SYNCED
  return { ocrQuality: view.ocrQuality, ocrSource: view.ocrSource, ocrLow: view.low }
}

/** `{ocrNotice}` when anything in the result is low, otherwise nothing. */
function noticeIf(anyLow: boolean): { ocrNotice?: string } {
  return anyLow ? { ocrNotice: RAG_OCR_LOW_NOTICE } : {}
}

// ---------------------------------------------------------------------------
// rag_query
// ---------------------------------------------------------------------------

export type OcrAnnotatedPassage = RagPassage & FolioOcrFields

export function annotatePassages(
  passages: RagPassage[],
  index: Map<string, FolioOcrView>,
): { passages: OcrAnnotatedPassage[]; ocrNotice?: string } {
  const annotated = passages.map((p) => ({
    ...p,
    ...(p.folio === null ? NOT_SYNCED : folioFields(index.get(folioOcrKey(p.ark, p.folio)))),
  }))
  return { passages: annotated, ...noticeIf(annotated.some((p) => p.ocrLow)) }
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
  return { hits: annotated, ...noticeIf(annotated.some((h) => h.ocrLowFolioCount > 0)) }
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
  index: Map<string, FolioOcrView>,
): { ocr: TextSliceOcr; ocrNotice?: string } {
  const { folios, leadingFolioKnown } = foliosInSlice(text)
  const annotated = folios.map((folio) => ({
    folio,
    ...folioFields(index.get(folioOcrKey(ark, folio))),
  }))
  return {
    ocr: { leadingFolioKnown, folios: annotated },
    ...noticeIf(annotated.some((f) => f.ocrLow)),
  }
}

// ---------------------------------------------------------------------------
// note_create / note_update / note_append
// ---------------------------------------------------------------------------

/** A low folio always has a measured quality (isLowOcr(null) is false). */
export type LowOcrCitation = { ark: string; folio: number; ocr_quality: number | null }

/**
 * The note's low text citations, one per (ark, folio), in body order. `rejected`
 * are the ARKs the corpus could not vouch for (NoteService): they have no
 * Citation row and are never reported, so the global table is not consulted
 * on the model's behalf for an ARK outside the corpus.
 */
export function lowOcrForNoteResult(
  body: string,
  index: Map<string, FolioOcrView>,
  rejected: string[],
): LowOcrCitation[] {
  const excluded = new Set(rejected)
  const seen = new Set<string>()
  const out: LowOcrCitation[] = []
  for (const c of parseCitations(body)) {
    const key = folioOcrKey(c.ark, c.folio)
    const view = index.get(key)
    if (view === undefined || !view.low || excluded.has(c.ark) || seen.has(key)) continue
    seen.add(key)
    out.push({ ark: c.ark, folio: c.folio, ocr_quality: view.ocrQuality })
  }
  return out
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/** The stored quality of the given folios, indexed by (ark, folio). */
export async function loadFolioIndex(refs: FolioRef[]): Promise<Map<string, FolioOcrView>> {
  const rows = await DocumentQueries.ocrForRefs(refs)
  return indexFolioOcr(rows.map(toFolioOcrView))
}

/** The OCR summaries of the given ARKs, indexed by ARK (absent = pending). */
export async function loadDocOcrIndex(arks: string[]): Promise<Map<string, DocumentOcrView>> {
  const rows = await DocumentQueries.ocrForArks([...new Set(arks)])
  return new Map(rows.map((r) => [r.ark, toDocumentOcrView(r.ark, r)]))
}
