// lib/constants.ts
// Cross-cutting string/number constants for the BnF Corpus Research app.
// Rule: no magic numbers in routes, services, or components — import from here.
// See playbook/constants.md.

/** Number of sample documents returned in a CorpusSnapshot. */
export const CORPUS_SAMPLE_SIZE = 25

/**
 * The seq assigned to the first (empty) CorpusVersion created by
 * ProjectService.create(). Invariant 1: every project always has a head.
 */
export const PROJECTS_INITIAL_VERSION_SEQ = 1

// ---------------------------------------------------------------------------
// BnF MCP concurrency + retry tuning
// ---------------------------------------------------------------------------

/** Maximum number of in-flight MCP calls when resolving a batch of ARKs. */
export const BNF_MCP_CONCURRENCY = 8

/** Total call attempts (1 initial + N-1 retries) per MCP request. */
export const BNF_MCP_RETRY_ATTEMPTS = 3

/** Base retry delay in ms (before jitter). Doubles on each attempt. */
export const BNF_MCP_RETRY_BASE_MS = 500

/** Maximum retry delay cap in ms (before jitter). */
export const BNF_MCP_RETRY_CAP_MS = 8_000
