// models/ingest/schema.ts
// Domain enums and re-exported Prisma types for the IngestJob model.
// No `import "server-only"` — schema is referenced by both client and server.
import type { IngestJob } from "@/lib/generated/prisma/client"

export const INGEST_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  DONE: "done",
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
