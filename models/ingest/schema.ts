// models/ingest/schema.ts
// Domain enums and re-exported Prisma types for the IngestJob model.
// No `import "server-only"` — schema is referenced by both client and server.
import type { IngestJob } from "@/lib/generated/prisma/client"
import {
  PAID_OCR_FALLBACK_PAGES,
  PAID_OCR_MAX_PAGES_PER_DOC,
  PAID_OCR_USD_PER_1K_PAGES,
} from "@/lib/constants"

export const INGEST_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  DONE: "done",
  // PARTIAL — most docs indexed, at least one failed. The successes ARE in the
  // index (their Document.indexedAt is stamped, so they drop out of the delta);
  // only the failed docs remain to ingest. Distinct from FAILED (nothing usable
  // committed) so the UI can show "N indexed / M failed" instead of "Échec".
  PARTIAL: "partial",
  FAILED: "failed",
  CANCELED: "canceled",
} as const
export type IngestStatus = (typeof INGEST_STATUS)[keyof typeof INGEST_STATUS]

export const INGEST_STAGE = {
  EXTRACT: "extract",
  CHUNK: "chunk",
  EMBED: "embed",
  INDEX: "index",
} as const
export type IngestStage = (typeof INGEST_STAGE)[keyof typeof INGEST_STAGE]

/** Cost estimate for transcribing a set of `sans_texte` documents via paid OCR. */
export interface PaidOcrEstimate {
  /** Number of `sans_texte` documents the estimate covers. */
  docCount: number
  /** Total folios to transcribe, after the null-fallback and per-doc cap. */
  pages: number
  /** Estimated USD cost at the Mistral OCR Batch rate. */
  usd: number
}

/**
 * Estimate the paid-OCR cost for a list of documents from their page counts.
 *
 * A null/zero/absent page count (an unresolved stub) is charged at
 * {@link PAID_OCR_FALLBACK_PAGES}; every document is capped at
 * {@link PAID_OCR_MAX_PAGES_PER_DOC} (the worker drops folios beyond that). The
 * result is an ESTIMATE shown at the confirmation prompt — the worker reports
 * the real billed cost on completion. Pure; safe on both client and server.
 */
export function estimatePaidOcrCostUsd(
  pageCounts: ReadonlyArray<number | null | undefined>,
): PaidOcrEstimate {
  const pages = pageCounts.reduce<number>((sum, p) => {
    const count = typeof p === "number" && p > 0 ? p : PAID_OCR_FALLBACK_PAGES
    return sum + Math.min(count, PAID_OCR_MAX_PAGES_PER_DOC)
  }, 0)
  return {
    docCount: pageCounts.length,
    pages,
    usd: (pages / 1000) * PAID_OCR_USD_PER_1K_PAGES,
  }
}

export type { IngestJob }
