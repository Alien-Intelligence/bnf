/**
 * Track 2 internal row types — mirror the schema in src/queue/schema.sql.
 *
 * These never leak into Track 1 / Track 3. They're for the queue, the runner,
 * and the smoke scripts only.
 */

export type IngestJobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "canceled";

export type DocumentIngestJobStatus =
  | "pending"
  | "extracting"
  | "chunking"
  | "embedding"
  | "indexing"
  // Set by the runner just before rethrowing a transient error so pg-boss
  // can retry. The next attempt transitions back through `extracting` →
  // `indexing` → `done`. Distinct from `pending` (never picked up) and
  // `failed` (terminal).
  | "awaiting_retry"
  | "done"
  | "failed"
  | "skipped";

export type DocumentIngestStateStatus =
  | "never"
  | "ingested"
  | "failed"
  | "skipped";

export interface IngestJobRow {
  id: string;
  projectId: string;
  status: IngestJobStatus;
  totalDocs: number;
  addedCount: number;
  removedCount: number;
  doneCount: number;
  failedCount: number;
  skippedCount: number;
  chunksWritten: number;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface DocumentIngestJobRow {
  id: string;
  ingestJobId: string;
  projectId: string;
  ark: string;
  pipeline: string | null;
  status: DocumentIngestJobStatus;
  skipReason: string | null;
  contentHash: string | null;
  entryId: number | null;
  chunksWritten: number;
  attempts: number;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface DocumentIngestStateRow {
  projectId: string;
  ark: string;
  status: DocumentIngestStateStatus;
  pipeline: string | null;
  contentHash: string | null;
  lastJobId: string | null;
  entryId: number | null;
  chunksWritten: number;
  lastError: string | null;
  updatedAt: Date;
}

/** Payload pushed onto pg-boss. Kept tiny on purpose. */
export interface DocJobQueuePayload {
  docJobId: string;
}

export const DOC_QUEUE_NAME = "bnf.ingest.doc";
