/**
 * Lane classification — the metadata stage's routing decision, lifted verbatim
 * from V1's extract.ts so the three lanes stay identical to the proven pipeline:
 *
 *   - ocrAvailable (BnF text layer)        → text   (ALTO, no manifest)
 *   - visual docType (estampe/carte/…)     → vision (IIIF image → Holo/Gemini)
 *   - sans_texte text doc + paid OCR on    → mistral (IIIF image → Mistral OCR)
 *   - sans_texte text doc + paid OCR off   → skip "no_ocr_and_not_single_image"
 *
 * Pure function over BnfDocInfo + the one runtime flag (paid OCR enabled). The
 * Latin-script gate + per-ingestion spend confirmation are enforced UPSTREAM by
 * the app before the doc is ever seeded (V1 semantics) — a doc reaching the
 * mistral branch here is already cleared to pay.
 */
import type { Lane } from "../domain/queues.js";
import type { BnfDocInfo } from "./types.js";

/** Visual-only doc_type substrings → vision lane (case-insensitive, matches V1). */
const IMAGE_DOC_TYPE_PATTERNS = [
  "image",
  "carte",
  "estampe",
  "photograph",
  "partition",
  // The IIIF manifest labels scores "Musique notée" / "musique manuscrite" — no
  // "partition" token — so an OCR-less score would miss the visual lane and skip.
  "musique",
  "affiche",
  "manuscrit",
  "dessin",
  "iconograph",
] as const;

export function isImageDocType(docType: string | null): boolean {
  if (!docType) return false;
  const dt = docType.toLowerCase();
  return IMAGE_DOC_TYPE_PATTERNS.some((p) => dt.includes(p));
}

export type LaneDecision =
  | { kind: "lane"; lane: Lane }
  | { kind: "skip"; reason: string };

export function classifyLane(
  info: Pick<BnfDocInfo, "ocrAvailable" | "docType">,
  opts: { mistralEnabled: boolean },
): LaneDecision {
  if (info.ocrAvailable) return { kind: "lane", lane: "text" };
  if (isImageDocType(info.docType)) return { kind: "lane", lane: "vision" };
  if (opts.mistralEnabled) return { kind: "lane", lane: "mistral" };
  return { kind: "skip", reason: "no_ocr_and_not_single_image" };
}
