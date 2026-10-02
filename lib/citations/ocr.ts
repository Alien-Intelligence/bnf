/**
 * lib/citations/ocr.ts
 *
 * Pure OCR-quality helpers over citations and processed text — no server-only
 * imports; safe client-side (note pills, banner, exports) and server-side
 * (agent tools). Feedback 2026-09-29 #7, Track B.
 *
 * "Low" itself is decided in ONE place, models/documents/schema.ts isLowOcr()
 * (via toFolioOcrView); these helpers only look views up.
 */
import { PROCESSED_TEXT_FOLIO_HEADING } from "@/lib/constants"
import type { FolioOcrView } from "@/models/documents/schema"

import { parseCitations, type ParsedCitation } from "./syntax"

/** A [0, 1] quality or rate as the whole percentage the UI shows (0.661 → 66). */
export function ocrPercent(fraction: number): number {
  return Math.round(fraction * 100)
}

/** Map key of one (ark, folio). */
export function folioOcrKey(ark: string, folio: number): string {
  return `${ark}#${folio}`
}

/** Index folio views by (ark, folio) for O(1) lookups while rendering a note. */
export function indexFolioOcr(views: FolioOcrView[]): Map<string, FolioOcrView> {
  return new Map(views.map((v) => [folioOcrKey(v.ark, v.folio), v]))
}

/**
 * The TEXT citations of a note body whose folio is low OCR, in body order.
 * Image embeds `![[…]]` are excluded (plan D11): they show the page image
 * itself and carry no transcription. A citation whose folio has no stored
 * quality (not synced yet, or a mistral/vision page) is not low.
 */
export function lowOcrCitations(
  body: string,
  index: Map<string, FolioOcrView>,
): ParsedCitation[] {
  return parseCitations(body).filter(
    (c) => index.get(folioOcrKey(c.ark, c.folio))?.low === true,
  )
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
