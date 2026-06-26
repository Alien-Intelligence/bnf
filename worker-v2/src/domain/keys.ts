/**
 * S3 key scheme — deterministic, content-addressed by ARK (+ folio). The presence
 * of a key is the idempotency/resume signal: a stage whose artifact key exists
 * skips its external call. Heavy bytes (manifest/ALTO/image) and the small
 * per-stage outcome pointers both live here under distinct prefixes.
 *
 * `slug` is the ARK body with the "ark:/12148/" prefix stripped and slashes
 * normalised, so keys are flat and filesystem/S3-safe.
 */
export function arkSlug(ark: string): string {
  return ark.replace(/^ark:\/12148\//, "").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export const keys = {
  /** OAI metadata JSON (docType, ocrAvailable, pageCount, title…). */
  metadata: (ark: string) => `meta/${arkSlug(ark)}.json`,
  /** IIIF manifest JSON (canvas list / total pages). */
  manifest: (ark: string) => `manifest/${arkSlug(ark)}.json`,
  /** One folio's ALTO XML. */
  alto: (ark: string, ordre: number) => `alto/${arkSlug(ark)}/f${ordre}.xml`,
  /** One folio's image bytes. */
  image: (ark: string, ordre: number) => `image/${arkSlug(ark)}/f${ordre}.jpg`,
  /** Per-doc assembled text pages (text lane) / OCR pages (mistral) / descriptions (vision). */
  pages: (ark: string) => `pages/${arkSlug(ark)}.json`,
  /** Mistral batch handle for a doc (batch_id + custom_id map). */
  ocrBatch: (ark: string) => `ocr-batch/${arkSlug(ark)}.json`,
  /** Embeddings for a doc. */
  embeddings: (ark: string) => `embed/${arkSlug(ark)}.json`,
  /** Terminal registration receipt — its presence means the doc is fully ingested. */
  registered: (ark: string) => `registered/${arkSlug(ark)}.json`,

  /** Per-stage OUTCOME cache (the small emit/done envelope the base persists). */
  outcome: (stage: string, ark: string, ordre?: number) =>
    ordre === undefined
      ? `outcome/${stage}/${arkSlug(ark)}.json`
      : `outcome/${stage}/${arkSlug(ark)}/f${ordre}.json`,
};
