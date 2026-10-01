// lib/mcp/rate-limited-registry.ts
// Enforcement point (b) of the BnF MCP rate limiter: a ToolRegistry decorator.
//
// The chat-sdk dispatches the raw `bnf__*` MCP tools itself — app code never
// sees those calls, and the registry's `onToolStart` hook is sync-only and
// cannot veto. But `ToolRegistry` is a plain interface and every SDK dispatch
// site (the durable turn runtime, the Claude runner, the OpenRouter runner)
// calls `.dispatch` on the registry object it was handed. Wrapping `dispatch`
// therefore sees every `bnf__*` call before the SDK sends it, parent turn and
// sub-agent alike, with no SDK change. See lib/mcp/rate-limit.ts for the
// coverage contract and playbook/mcp-client.md for the rule: every registry
// built in app code MUST be wrapped with `withBnfRateLimit`.
import "server-only"

import type { ToolContext, ToolRegistry } from "@alien/chat-sdk/claude"
import { acquireBnfMcp, quotaSaturatedResult } from "./rate-limit"
import { bnfToolFromPrefixed } from "./tools"

/**
 * Wrap a registry so every `bnf__<tool>` dispatch first takes its tokens from
 * the process-wide BnF buckets. A refused call never reaches the registry and
 * returns `{ isError: true, content: <quota saturé> }` — never a throw
 * (CLAUDE_ERROR_PATTERNS §15). Custom app tools pass straight through: the
 * ones that call BnF themselves (`corpus_search`) acquire inside `callBnfTool`.
 *
 * An abort during the wait is coerced into an error result exactly as the
 * underlying SDK dispatch coerces an aborted MCP transport (verified in
 * @alien/chat-sdk dist/claude/index.js `callMcpServerTool`: it catches and
 * returns `isError: true`), so the turn runtime sees one behaviour whichever
 * layer the cancellation lands in.
 */
export function withBnfRateLimit<TCtx extends ToolContext>(
  registry: ToolRegistry<TCtx>,
): ToolRegistry<TCtx> {
  return {
    customTools: registry.customTools,
    mcpServers: registry.mcpServers,
    resolve: (signal) => registry.resolve(signal),
    async dispatch(toolName, input, ctx, toolUseId) {
      const tool = bnfToolFromPrefixed(toolName)
      if (tool !== null) {
        let grant
        try {
          grant = await acquireBnfMcp(tool, input, ctx.signal)
        } catch (err) {
          if (!ctx.signal.aborted) throw err
          return {
            isError: true,
            content: `Tool "${toolName}" aborted: ${err instanceof Error ? err.message : String(err)}`,
          }
        }
        if (!grant.ok) {
          return { isError: true, content: JSON.stringify(quotaSaturatedResult(grant)) }
        }
      }
      return registry.dispatch(toolName, input, ctx, toolUseId)
    },
  }
}
