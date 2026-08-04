// Re-export the registry factory so callers only need to import from this module.
export { buildTurnScopedCtx, buildTurnScopedRegistry } from "./registry-factory"
export type { BuildTurnCtxOpts, TurnScopedCtx } from "./registry-factory"

// Tool name constants and the derived union type.
export { AGENT_TOOLS } from "./constants"
export type { AgentToolName } from "./constants"

// Individual tool group arrays (useful for selective registry composition).
export { corpusTools } from "./corpus"
export { bufferTools } from "./buffer"
export { memoryTools } from "./memory"
export { ingestTools } from "./ingest"
export { ragTools } from "./rag"
export { noteTools } from "./note"
export { docTools } from "./doc"
export { interactionTools } from "./interaction"

import { corpusTools } from "./corpus"
import { bufferTools } from "./buffer"
import { memoryTools } from "./memory"
import { ingestTools } from "./ingest"
import { ragTools } from "./rag"
import { noteTools } from "./note"
import { docTools } from "./doc"
import { interactionTools } from "./interaction"

/**
 * The app-defined tools available in EVERY session regardless of scope: project
 * memory (durable facts) and the interaction/ask_user primitive.
 */
const sharedTools = [...memoryTools, ...interactionTools]

/**
 * Compose the app-defined `defineTool` handlers for a session scope — the
 * BOUNDARY gate (design item 4, plan §3.5 layer 1). A corpus session must not
 * carry note tools; a research session must not carry corpus/buffer tools.
 * Registration-time gating, not just prompt framing:
 *   - corpus   → corpus_*, buffer_* (incl. corpus_search), ingest_submit + shared
 *   - research → rag_*, note_*, doc_* + shared
 * MCP tools (BnF search/read) are attached separately in buildTurnScopedRegistry
 * and are not gated here (McpServerConfig has no per-tool filter).
 */
export function toolsForScope(scope: "corpus" | "research") {
  if (scope === "corpus") {
    return [...corpusTools, ...bufferTools, ...ingestTools, ...sharedTools]
  }
  return [...ragTools, ...noteTools, ...docTools, ...sharedTools]
}
