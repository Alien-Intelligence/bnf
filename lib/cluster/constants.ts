// lib/cluster/constants.ts
// The worker's queue read-model vocabulary — stage-bucket names and per-doc
// status keys — as named constants. The worker owns these strings; the app
// consumes `ClusterQueueProgress.stages` / `.docs` keyed by them (see
// lib/cluster/contracts.ts, which stays pure types). Centralised here so the
// panel's phase narrative (lib/ingest/stage-narrative.ts) and the debug detail
// (components/cards/ingest/queue-detail.tsx) read one source instead of
// hand-duplicating the literals — a worker-side rename then changes one place.

/** Worker stage-bucket keys, in pipeline order. */
export const WORKER_STAGE = {
  METADATA: "metadata",
  MANIFEST: "manifest",
  FETCH: "fetch",
  DESCRIBE: "describe",
  ASSEMBLE: "assemble",
  EMBED: "embed",
  OCR_SUBMIT: "ocrSubmit",
  OCR_POLL: "ocrPoll",
  REGISTER: "register",
} as const

/** Worker per-doc status keys (the reconciling `docs` tally). */
export const WORKER_DOC_STATUS = {
  PLANNED: "planned",
  FETCHING: "fetching",
  READY: "ready",
  PROCESSING: "processing",
  DONE: "done",
  QUEUED: "queued",
  FAILED: "failed",
  SKIPPED: "skipped",
  EXCLUDED: "excluded",
} as const
