// lib/constants.ts
// Cross-cutting string/number constants for the BnF Corpus Research app.
// Rule: no magic numbers in routes, services, or components — import from here.
// See playbook/constants.md.

/**
 * Number of documents per page in a CorpusSnapshot.
 * Also used as the initial sample size when no pagination cursor is provided.
 * Applies to both the slice-1 "first 25" preview and the slice-2 paginated
 * list (cursor-based pagination uses the same page size).
 */
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

// ---------------------------------------------------------------------------
// Agent runtime
// ---------------------------------------------------------------------------

/** Claude model id used for both the corpus and research agent loops.
 * Must be a Sonnet-class model per the design spec (design/docs/08-prompting). */
export const AGENT_MODEL = "claude-sonnet-4-6"

/** Hard cap on tool-loop iterations per turn.  Matches the chat-sdk default
 * (maxToolTurns = 12) but declared here so it can be tuned without touching
 * the runner. */
export const AGENT_MAX_ITERATIONS = 12

// ---------------------------------------------------------------------------
// Reaper tuning
// ---------------------------------------------------------------------------

/** Maximum age (ms) of a running turn before the reaper aborts it.
 * 30 minutes: generous enough for a large corpus ingestion MCP call but
 * short enough to catch runaway turns before they exhaust memory. */
export const TURN_REAP_TTL_MS = 30 * 60 * 1_000

/** How often the reaper runs its cycle (ms).
 * 5 minutes: frequent enough to catch orphaned DB rows promptly. */
export const REAPER_INTERVAL_MS = 5 * 60 * 1_000

// ---------------------------------------------------------------------------
// Corpus live-refresh
// ---------------------------------------------------------------------------

/**
 * Debounce window (ms) before invalidating corpus queries after a
 * `corpus_event` arrives from the agent stream.
 * Prevents a rapid sequence of add/remove calls from triggering multiple
 * refetches — only the trailing edge fires.
 */
export const CORPUS_REFRESH_DEBOUNCE_MS = 500
