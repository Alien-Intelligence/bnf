// models/health/schema.ts
// Types + pure classification logic for the workspace health indicator.
// No imports from other model directories — schema.ts is the foundation layer.
//
// The indicator answers a simple operational question for the librarian: are
// the three moving parts behind the agent healthy right now?
//   • app   — this Next.js app's own tools (corpus, notes, memory, ingest, doc)
//   • alien — the Alien data-cluster RAG (the rag_* tools relay to it)
//   • bnf   — the BnF, relayed through the (Alien-hosted) BnF MCP server
//
// Health is derived purely from tool-call outcomes persisted in `tool_call`
// over a sliding window (see HEALTH_WINDOW_MS). There is no active probe: a BnF
// MCP that fails to load emits no tool calls, so its lane simply stays green
// (per product decision — "if the MCP is down, assume the BnF is green"). The
// lanes flare only on REAL relayed failures (429/401/403/500, cluster errors,
// internal exceptions) the agent actually hit.

/** A lane's health. green = no failures; orange = mixed; red = only failures. */
export type HealthStatus = "green" | "orange" | "red"

/** The three lanes the indicator surfaces. */
export type HealthLane = "app" | "alien" | "bnf"

/** Per-lane success/failure tallies within the window. */
export type LaneTally = { ok: number; error: number }

/** A lane's resolved status plus the tallies it was derived from (the UI shows
 *  the counts in a tooltip). `unreachable` is set on the Alien lane when a
 *  hosted MCP server failed its connectivity probe — the lane is red because a
 *  server is down, NOT because tool calls failed, so the UI explains it
 *  differently (the tallies will read 0/0). */
export type LaneHealth = LaneTally & {
  status: HealthStatus
  unreachable?: boolean
}

/** The snapshot the health endpoint returns and the header renders. */
export type HealthSnapshot = {
  app: LaneHealth
  alien: LaneHealth
  bnf: LaneHealth
  /** The window width (ms) the tallies cover — echoed so the client can label
   *  "over the last 5 min" without hard-coding it. */
  windowMs: number
}

/**
 * Classify a persisted tool call into a health lane from its name + MCP origin.
 *
 *   • bnf   — MCP tools relayed by the "bnf" server (source="mcp", server="bnf")
 *   • alien — the data-cluster RAG tools (rag_query / rag_keyword_search /
 *             rag_get_text) — app-defined wrappers that call the cluster, so
 *             their failure means the cluster (Alien) is unhealthy
 *   • app   — every other internal tool (corpus_*, note_*, memory_*, ingest_*,
 *             doc_*)
 *
 * Returns null for calls that carry no service-health signal (e.g. `ask_user`,
 * a pure UI interaction) so they are excluded from every lane.
 */
export function classifyHealthLane(call: {
  tool: string
  source: string
  serverName: string | null
}): HealthLane | null {
  if (call.source === "mcp") {
    return call.serverName === "bnf" ? "bnf" : null
  }
  if (call.tool.startsWith("rag_")) return "alien"
  if (
    call.tool.startsWith("corpus_") ||
    call.tool.startsWith("note_") ||
    call.tool.startsWith("memory_") ||
    call.tool.startsWith("ingest_") ||
    call.tool.startsWith("doc_")
  ) {
    return "app"
  }
  return null
}

/**
 * Resolve a lane's status from its tallies, per the product spec:
 *   • no failures        → green  (includes the idle case: 0 calls)
 *   • failures + successes → orange (degraded — some calls got through)
 *   • failures, no success → red    (the service looks down)
 */
export function laneStatus(tally: LaneTally): HealthStatus {
  if (tally.error === 0) return "green"
  if (tally.ok > 0) return "orange"
  return "red"
}
