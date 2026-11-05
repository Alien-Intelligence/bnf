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

/**
 * How the BnF names a document's language in the manifest's "Langue" field —
 * its French label, not an ISO code. worker-v2 copies it onto the entry
 * unchanged, so `rag_keyword_search`'s `lang` filter must be written this way
 * (an exact match on the stored value).
 */
export const BNF_LANGUAGE_LABEL = {
  FRENCH: "Français",
  ENGLISH: "Anglais",
} as const

/** The `response_format` the app asks the data-cluster MCP's list, get and keyword tools for. */
export const DATACLUSTER_RESPONSE_FORMAT = { JSON: "json" } as const

/**
 * What an ARK lookup — an empty keyword search filtered on the ark, scoped to
 * the project's dataset — is called in errors and in the tenancy check, which
 * otherwise names the MCP tool it checked.
 */
export const ARK_LOOKUP_LABEL = "ARK lookup"

/**
 * The two modes of `datacluster_get_entry_content` whose replies must carry
 * pagination fields (the third, full mode, returns the raw payload). The
 * values name the mode in protocol-error messages.
 */
export const ENTRY_CONTENT_MODE = {
  PAGINATED: "paginated",
  OFFSET_ONLY: "offset-only",
} as const
export type EntryContentMode = (typeof ENTRY_CONTENT_MODE)[keyof typeof ENTRY_CONTENT_MODE]
