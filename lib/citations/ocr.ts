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
import { folioOcrState, type OcrIndex } from "@/lib/ocr/quality"

import { parseCitations, type ParsedCitation } from "./syntax"

/**
 * The TEXT citations of a note body, split by what is known of their folio's
 * OCR (image embeds `![[…]]` are excluded, plan D11 — they show the page image
 * and carry no transcription):
 *   low     — measured below the threshold: pill marker, banner, export marker;
 *   unknown — the folio's quality is not available (document not synced, or
 *             no stored row for that folio). Never shown as "not low": the
 *             agent and the side panel say "non disponible".
 * Everything else (measured and not low, or a recorded mistral/vision page)
 * is in neither list.
 */
export function citationOcrSummary(
  body: string,
  index: OcrIndex,
): { low: ParsedCitation[]; unknown: ParsedCitation[] } {
  const low: ParsedCitation[] = []
  const unknown: ParsedCitation[] = []
  for (const c of parseCitations(body)) {
    const state = folioOcrState(index, c.ark, c.folio)
    if (state.kind === "recorded") {
      if (state.view.low) low.push(c)
    } else {
      unknown.push(c)
    }
  }
  return { low, unknown }
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
