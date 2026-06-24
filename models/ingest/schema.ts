// models/ingest/schema.ts
// Domain enums and re-exported Prisma types for the IngestJob model.
// No `import "server-only"` — schema is referenced by both client and server.
import type { IngestJob } from "@/lib/generated/prisma/client"

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

export type { IngestJob }
