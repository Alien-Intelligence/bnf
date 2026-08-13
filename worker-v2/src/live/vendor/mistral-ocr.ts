/**
 * Mistral OCR hallucination detector — isolated from BnF knowledge and from the
 * Batch API mechanics.
 *
 * This module used to also own the V1-style blocking submit+wait+parse batch
 * call (`runMistralOcrBatch`); that mechanics is dead here — live/ocr.ts's
 * LiveOcrEngine reimplements it SPLIT into submit/poll (see ocr.ts's header
 * comment for why) and only ever imports `looksLikeHallucinatedOcr` from this
 * file. Removed rather than kept around unused (dead-code hygiene item,
 * ai-memories/tech/repos/bnf/ingest-hardening).
 */

/**
 * Detect a hallucinated OCR page — Mistral fabricates content on blank/near-blank
 * folios instead of returning empty: it repeats one filler line dozens of times
 * (e.g. "The following table is a simple diagram and cannot be extracted.") and
 * injects unrelated text (CJK boilerplate, leaked instructions). Per-page
 * confidence does NOT flag these (the model is confidently wrong — verified: a
 * garbage page scored avg 0.968 vs 0.936 for a clean one), so we key on the two
 * structural tells instead:
 *
 *   1. The SAME long line (≥12 chars) repeated ≥4×. Genuine prose never repeats
 *      a full sentence that many times; counting absolute repeats (not a ratio)
 *      avoids false-positiving a real page that is one long, unbroken paragraph.
 *   2. ≥2 lines matching the blank-region filler / instruction-leak markers.
 *
 * A flagged page is dropped (treated as a blank folio — no citation, which is
 * correct) rather than indexed, so fabricated text never reaches the RAG store.
 */
const HALLUCINATION_FILLER_RE =
  /cannot be extracted|simple (?:diagram|formula)|ground truth|underscore.{0,24}rule/i;

export function looksLikeHallucinatedOcr(markdown: string): boolean {
  const lines = markdown
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 12);
  if (lines.length === 0) return false;

  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  const maxRepeat = Math.max(...counts.values());
  if (maxRepeat >= 4) return true;

  const fillerLines = lines.filter((l) => HALLUCINATION_FILLER_RE.test(l)).length;
  return fillerLines >= 2;
}
