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

/**
 * The data-cluster MCP's tool names, as `tools/call` names them
 * (mcp-data-cluster; the BnF MCP's counterpart is BNF_MCP_TOOL in lib/mcp/tools.ts).
 */
export const DATACLUSTER_MCP_TOOL = {
  LIST_DATASETS: "datacluster_list_datasets",
  GET_DATASET: "datacluster_get_dataset",
  VECTOR_SEARCH_CHUNKS: "datacluster_vector_search_chunks",
  KEYWORD_SEARCH: "datacluster_keyword_search",
  GET_ENTRY_CONTENT: "datacluster_get_entry_content",
} as const
export type DataclusterMcpTool = (typeof DATACLUSTER_MCP_TOOL)[keyof typeof DATACLUSTER_MCP_TOOL]

/** The `response_format` the app asks the data-cluster MCP's list, get and keyword tools for. */
export const DATACLUSTER_RESPONSE_FORMAT = { JSON: "json" } as const

/**
 * What an ARK lookup — an empty keyword search filtered on the ark, scoped to
 * the project's dataset — is called in errors and in the tenancy check, which
 * otherwise names the MCP tool it checked.
 */
export const ARK_LOOKUP_LABEL = "ARK lookup"
