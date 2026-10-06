/**
 * Queue (bucket) names + the lane vocabulary. One queue == one stage's input.
 * The topology (see plan/v2-architecture-design.md):
 *
 *   metadata → [text: fan-out alto folios → FETCH_ALTO]
 *            → [image/mistral: → MANIFEST → fan-out image folios → FETCH_IMAGE]
 *   FETCH_ALTO  (gate: presentation ∧ global) ┐
 *   FETCH_IMAGE (gate: image ∧ global)        ┴→ folio-result → MONITOR (fan-in per doc)
 *   MONITOR → route by lane:
 *       text    → ASSEMBLE  → EMBED → REGISTER
 *       vision  → DESCRIBE  → EMBED → REGISTER
 *       mistral → OCR_SUBMIT → OCR_POLL → EMBED → REGISTER
 *
 * ALTO and images are two queues with two stages, each on its own gate and
 * concurrency, so images waiting on the scarce Image quota can never occupy the
 * slots ALTO needs (one images-first queue would starve ALTO).
 */
export const Q = {
  metadata: "v2.metadata",
  manifest: "v2.manifest",
  /** ALTO folios. The queue name is the pre-split fetch queue's, so ALTO
   *  messages in flight across the deploy are consumed unchanged. */
  fetchAlto: "v2.fetch",
  /** Image folios (vision + mistral lanes). */
  fetchImage: "v2.fetch.image",
  monitor: "v2.monitor",
  assemble: "v2.assemble",
  describe: "v2.describe",
  ocrSubmit: "v2.ocr.submit",
  ocrPoll: "v2.ocr.poll",
  embed: "v2.embed",
  register: "v2.register",
  /** OCR-quality backfill — NOT part of a run: fed by POST /ocr-quality/sync,
   *  one `{ark}` per missing per-ARK artifact (stages/ocr-quality-backfill.ts). */
  ocrQualityBackfill: "v2.ocr-quality.backfill",
} as const;

export type QueueName = (typeof Q)[keyof typeof Q];

/** A document's processing lane, decided by the metadata stage from docType + OCR availability. */
export type Lane = "text" | "vision" | "mistral";

/** What a folio fetch pulls from BnF. */
export type FolioKind = "alto" | "image";

/** Send-priority within a fetch queue: Mistral images before vision images on
 *  the image queue (the paid OCR batch is the long tail). Higher = sooner. */
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
 * the image queue drain tail-first. A replayed folio keeps the same priority it
 * would have had first time round.
 */
export function withFetchPriority<T extends { lane: Lane }>(
  items: readonly T[],
): Array<T & { priority: number }> {
  return items.map((it) => ({ ...it, priority: FETCH_PRIORITY[it.lane] }));
}

/** What sendFolios needs of the transport (core/types.ts QueueClient satisfies it;
 *  domain/ does not import core/). */
export interface FolioSink {
  sendMany<P>(queue: string, payloads: readonly P[]): Promise<void>;
}

/** The fetch queue of each folio kind. */
export const FETCH_QUEUE: Readonly<Record<FolioKind, QueueName>> = {
  alto: Q.fetchAlto,
  image: Q.fetchImage,
};

/**
 * THE way fetch work is enqueued: each folio goes to its kind's queue, with
 * its lane's priority. Every producer goes through here — the metadata
 * fan-out, the manifest fan-out, the sweep's rebuild and the ALTO stage's
 * forwarding of a pre-split image message — so no producer can put a folio on
 * the other kind's queue.
 */
export async function sendFolios<T extends { kind: FolioKind; lane: Lane }>(
  queue: FolioSink,
  items: readonly T[],
): Promise<void> {
  for (const kind of ["alto", "image"] as const) {
    const ofKind = items.filter((it) => it.kind === kind);
    if (ofKind.length > 0) await queue.sendMany(FETCH_QUEUE[kind], withFetchPriority(ofKind));
  }
}
