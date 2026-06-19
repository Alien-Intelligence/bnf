// Re-export the registry factory so callers only need to import from this module.
export { buildTurnScopedCtx, buildTurnScopedRegistry } from "./registry-factory"
export type { BuildTurnCtxOpts, TurnScopedCtx } from "./registry-factory"

// Tool name constants and the derived union type.
export { AGENT_TOOLS } from "./constants"
export type { AgentToolName } from "./constants"

// Individual tool group arrays (useful for selective registry composition).
export { corpusTools } from "./corpus"
export { memoryTools } from "./memory"
export { ingestTools } from "./ingest"
export { ragTools } from "./rag"
export { noteTools } from "./note"
export { docTools } from "./doc"
export { interactionTools } from "./interaction"

// Aggregate array — pass to createToolRegistry({ tools: appTools }).
import { corpusTools } from "./corpus"
import { memoryTools } from "./memory"
import { ingestTools } from "./ingest"
import { ragTools } from "./rag"
import { noteTools } from "./note"
import { docTools } from "./doc"
import { interactionTools } from "./interaction"

/**
 * All app-defined `defineTool` handlers as a single flat array.
 *
 * Usage in buildTurnScopedRegistry:
 *   createToolRegistry<TurnScopedCtx>({ tools: appTools, mcpServers: [...] })
 */
export const appTools = [
  ...corpusTools,
  ...memoryTools,
  ...ingestTools,
  ...ragTools,
  ...noteTools,
  ...docTools,
  ...interactionTools,
] as const
