/**
 * Queue (bucket) names + the lane vocabulary. One queue == one stage's input.
 * The topology (see plan/v2-architecture-design.md):
 *
 *   metadata → [text: fan-out alto folios → FETCH]
 *            → [image/mistral: → MANIFEST (42/min) → fan-out image folios → FETCH]
 *   FETCH (300/min, all lanes) → folio-result → MONITOR (fan-in per doc)
 *   MONITOR → route by lane:
 *       text    → ASSEMBLE  → EMBED → REGISTER
 *       vision  → DESCRIBE  → EMBED → REGISTER
 *       mistral → OCR_SUBMIT → OCR_POLL → EMBED → REGISTER
 */
export const Q = {
  metadata: "v2.metadata",
  manifest: "v2.manifest",
  fetch: "v2.fetch",
  monitor: "v2.monitor",
  assemble: "v2.assemble",
  describe: "v2.describe",
  ocrSubmit: "v2.ocr.submit",
  ocrPoll: "v2.ocr.poll",
  embed: "v2.embed",
  register: "v2.register",
} as const;

export type QueueName = (typeof Q)[keyof typeof Q];

/** A document's processing lane, decided by the metadata stage from docType + OCR availability. */
export type Lane = "text" | "vision" | "mistral";

/** What a folio fetch pulls from BnF. */
export type FolioKind = "alto" | "image";

/** Send-priority so the BnF fetch queue is tail-first (Mistral images first, then
 *  vision images, then ALTO text fills the batch shadow). Higher = sooner. */
export const FETCH_PRIORITY: Record<Lane, number> = {
  mistral: 100,
  vision: 50,
  text: 10,
};

/**
 * Where a routed doc goes once its folios are all in — the Monitor's routing
 * table. Also the table the reconciliation sweep and the requeue CLI rebuild a
 * stranded doc's lane message from, so it lives here rather than being restated
 * per caller (three copies of a routing table is three chances to drift).
 */
export const LANE_QUEUE: Record<Lane, string> = {
  text: Q.assemble,
  vision: Q.describe,
  mistral: Q.ocrSubmit,
};

/**
 * Stamp each folio item with its lane's fetch priority. pg-boss reads `priority`
 * off the payload at send time (the memory queue ignores it), which is what makes
 * the fetch bucket drain tail-first. Every producer of fetch work goes through
 * here — the metadata fan-out, the manifest fan-out, and the sweep's rebuild — so
 * a replayed folio keeps the same priority it would have had first time round.
 */
export function withFetchPriority<T extends { lane: Lane }>(
  items: readonly T[],
): Array<T & { priority: number }> {
  return items.map((it) => ({ ...it, priority: FETCH_PRIORITY[it.lane] }));
}
