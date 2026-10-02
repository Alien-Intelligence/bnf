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
import { acquireBnfMcp, assertBnfRateLimiterConfigured, quotaSaturatedResult } from "./rate-limit"
import { BNF_MCP_SERVER_NAME, bnfToolFromPrefixed } from "./tools"

/**
 * Wrap a registry so every `bnf__<tool>` dispatch first takes its tokens from
 * the process-wide BnF buckets. A refused call never reaches the registry and
 * returns `{ isError: true, content: <quota saturé> }` — never a throw
 * (CLAUDE_ERROR_PATTERNS §15). Custom app tools pass straight through: the
 * ones that call BnF themselves (`corpus_search`) acquire inside `callBnfTool`.
 *
 * When the registry carries the BnF MCP server, the limiter's required config
 * is validated HERE, at build time: a missing BNF_MCP_RATE_* value fails the
 * turn before the model runs, with the variable named, rather than throwing out
 * of `dispatch` mid-loop. Without the server, no `bnf__*` tool is advertised to
 * the model, so nothing is validated (the MCP stays optional, as in
 * resolveMcpServers).
 *
 * `dispatch` never throws (CLAUDE_ERROR_PATTERNS §15). An abort during the wait
 * is coerced into an error result exactly as the underlying SDK dispatch
 * coerces an aborted MCP transport (verified in @alien/chat-sdk
 * dist/claude/index.js `callMcpServerTool`: it catches and returns
 * `isError: true`), so the turn runtime sees one behaviour whichever layer the
 * cancellation lands in. Any other limiter failure is logged and returned to
 * the model as an error result; the call is not sent.
 */
export function withBnfRateLimit<TCtx extends ToolContext>(
  registry: ToolRegistry<TCtx>,
): ToolRegistry<TCtx> {
  if (registry.mcpServers.some((s) => s.name === BNF_MCP_SERVER_NAME)) {
    assertBnfRateLimiterConfigured()
  }
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
          const message = err instanceof Error ? err.message : String(err)
          if (ctx.signal.aborted) {
            return { isError: true, content: `Tool "${toolName}" aborted: ${message}` }
          }
          console.error(`[bnf-rate] limiter failed for ${toolName} — call not sent:`, err)
          return {
            isError: true,
            content: `Tool "${toolName}" failed before reaching BnF (rate limiter): ${message}`,
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
