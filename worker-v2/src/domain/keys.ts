/**
 * S3 key scheme — deterministic, content-addressed by ARK (+ folio). The presence
 * of a key is the idempotency/resume signal: a stage whose artifact key exists
 * skips its external call. Heavy bytes (manifest/ALTO/image) and the small
 * per-stage outcome pointers both live here under distinct prefixes.
 *
 * `slug` is the ARK body with the "ark:/12148/" prefix stripped and slashes
 * normalised, so keys are flat and filesystem/S3-safe.
 *
 * Content artifacts (manifest/alto/image/pages/embeddings) are genuinely
 * content-addressed by ARK alone and are INTENTIONALLY shared across projects —
 * the same BnF document fetched/OCR'd/embedded once serves every project that
 * ingests it. `registered`, in contrast, is per-project STATE (which dataset
 * this ARK landed in for THIS project), not shared content — see its own doc
 * comment (F16, ai-memories/tech/repos/bnf/ingest-hardening).
 */
export function arkSlug(ark: string): string {
  return safeSegment(ark.replace(/^ark:\/12148\//, ""));
}

/** Filter to flat, filesystem/S3-safe characters — shared by `arkSlug` and any
 *  other key segment (e.g. a projectId) embedded literally into a key. */
function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
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
  /**
   * Terminal registration receipt — its presence means THIS PROJECT has fully
   * ingested this ARK. Scoped by `projectId` (F16, ai-memories/tech/repos/bnf/
   * ingest-hardening): datasets are per-project, but the receipt used to be
   * keyed by ARK alone under the global `v2/` prefix, so a second project
   * ingesting an already-registered ARK — or the same project after its
   * dataset was deleted and recreated — dedup'd on a receipt that pointed at a
   * dataset it had never written to, marking the doc `done` while it stayed
   * absent from that project's actual dataset. Silent RAG holes.
   *
   * Migration: old global receipts (`registered/<slug>.json`) are simply
   * IGNORED by the register stage — never read, never migrated. This is safe
   * because the cluster's upsert is idempotent per (dataset, ark): re-running
   * it for a project that never actually got the doc just does the work it
   * should have done the first time. No backfill job needed.
   */
  registered: (projectId: string, ark: string) =>
    `registered/${safeSegment(projectId)}/${arkSlug(ark)}.json`,

  /** Per-stage OUTCOME cache (the small emit/done envelope the base persists). */
  outcome: (stage: string, ark: string, ordre?: number) =>
    ordre === undefined
      ? `outcome/${stage}/${arkSlug(ark)}.json`
      : `outcome/${stage}/${arkSlug(ark)}/f${ordre}.json`,
};
