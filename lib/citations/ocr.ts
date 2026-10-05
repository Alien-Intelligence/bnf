/**
 * lib/citations/ocr.ts
 *
 * Pure OCR-quality helpers over note citations and processed text — no
 * server-only imports; safe client-side (pills, banner, exports) and
 * server-side (agent tools). Feedback 2026-09-29 #7, Track B.
 *
 * "Low" and the per-folio states are decided in lib/ocr/quality.ts; these
 * helpers only classify citations and slices against an OcrIndex.
 */
import { PROCESSED_TEXT_FOLIO_HEADING } from "@/lib/constants"
import {
  folioOcrKey,
  folioOcrState,
  isOcrUnknown,
  type OcrIndex,
  type UnknownFolioOcrState,
} from "@/lib/ocr/quality"
import { FOLIO_OCR_STATE, type FolioOcrView } from "@/models/documents/schema"

import { parseCitations } from "./syntax"

/** A cited folio measured below the threshold, with its stored view. */
export type LowFolio = { ark: string; folio: number; view: FolioOcrView }
/** A cited folio whose quality is not known to the reader, with why. */
export type UnknownFolio = { ark: string; folio: number; state: UnknownFolioOcrState }

/**
 * THE classifier of cited folios (one implementation for the pills, the
 * banner, the exports and every agent tool): each (ark, folio) once, in
 * first-seen order, split by what is known of its OCR —
 *   low     — measured below the threshold: pill marker, banner, export marker;
 *   unknown — the quality is not known to the reader (isOcrUnknown: pending,
 *             unavailable, not recorded, revoked, check failed). Never shown
 *             or reported as "not low".
 * Everything else (measured and not low, or a recorded mistral/vision page)
 * is in neither list. A reference without a folio cites no page: skipped.
 */
export function classifyFolioRefs(
  refs: Array<{ ark: string; folio: number | null }>,
  index: OcrIndex,
): { low: LowFolio[]; unknown: UnknownFolio[] } {
  const low: LowFolio[] = []
  const unknown: UnknownFolio[] = []
  const seen = new Set<string>()
  for (const { ark, folio } of refs) {
    if (folio === null) continue
    const key = folioOcrKey(ark, folio)
    if (seen.has(key)) continue
    seen.add(key)
    const state = folioOcrState(index, ark, folio)
    if (state.kind === FOLIO_OCR_STATE.RECORDED) {
      if (state.view.low) low.push({ ark, folio, view: state.view })
    } else if (isOcrUnknown(state)) {
      unknown.push({ ark, folio, state })
    }
  }
  return { low, unknown }
}

/**
 * The TEXT citations of a note body, classified (classifyFolioRefs). Image
 * embeds `![[…]]` are not text citations (plan D11 — they show the page image
 * and carry no transcription): parseCitations never returns them.
 */
export function citationOcrSummary(
  body: string,
  index: OcrIndex,
): { low: LowFolio[]; unknown: UnknownFolio[] } {
  return classifyFolioRefs(parseCitations(body), index)
}

/**
 * The folios a slice of an entry's processed text covers, read from worker-v2's
 * `## Folio N` headings (PROCESSED_TEXT_FOLIO_HEADING, plan D12).
 *
 * `leadingFolioKnown` is false when the slice has content before its first
 * heading (it starts mid-folio): that leading folio is UNKNOWN and is never
 * guessed — it is not in `folios`.
 */
export function foliosInSlice(text: string): { folios: number[]; leadingFolioKnown: boolean } {
  const folios: number[] = []
  let firstHeadingAt: number | null = null
  for (const m of text.matchAll(PROCESSED_TEXT_FOLIO_HEADING)) {
    if (firstHeadingAt === null) firstHeadingAt = m.index
    folios.push(Number(m[1]))
  }
  const leadingFolioKnown =
    firstHeadingAt !== null && text.slice(0, firstHeadingAt).trim() === ""
  return { folios, leadingFolioKnown }
}
