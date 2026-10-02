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

import type { ToolContext, ToolDispatchResult, ToolRegistry } from "@alien/chat-sdk/claude"
import { bnfMcpUrlConfigured } from "@/lib/env"
import {
  acquireBnfMcp,
  assertBnfRateLimiterConfigured,
  bnfCallRefusedResult,
  isBnfMcpToolName,
  quotaSaturatedResult,
  reportBnfUpstreamRateLimit,
} from "./rate-limit"
import { BNF_MCP_SERVER_NAME, BNF_MCP_TOOLS, bnfToolFromPrefixed } from "./tools"

/** The SDK's text for an MCP transport failure carries the HTTP status
 *  (`MCP bnf tools/call HTTP 429: …`, @alien/chat-sdk dist/claude `rpc`). */
const HTTP_429_IN_ERROR_TEXT = /\bHTTP 429\b/

/**
 * True when the dispatched result says BnF answered 429: either the SDK's
 * transport error (HTTP 429 from the MCP/proxy), or mcp-bnf's soft-failure
 * envelope `{ success: false, status_code: 429 }` in the tool's JSON text.
 * The SDK drops response headers, so no Retry-After is available on this path.
 */
function isUpstreamRateLimited(result: ToolDispatchResult): boolean {
  if (result.isError && HTTP_429_IN_ERROR_TEXT.test(result.content)) return true
  let payload: unknown
  try {
    payload = JSON.parse(result.content)
  } catch {
    // Not JSON: a plain-text tool result, which cannot carry the envelope.
    return false
  }
  return (
    typeof payload === "object" &&
    payload !== null &&
    "success" in payload &&
    payload.success === false &&
    "status_code" in payload &&
    payload.status_code === 429
  )
}

/**
 * Wrap a registry so every `bnf__<tool>` dispatch first takes its tokens from
 * the process-wide BnF buckets. A refused call never reaches the registry and
 * returns `{ isError: true, content: <structured refusal> }` — never a throw
 * (CLAUDE_ERROR_PATTERNS §15):
 *   - an unknown `bnf__` tool (not in BNF_MCP_TOOLS) is refused outright — it
 *     has no API bucket, so it cannot be metered;
 *   - an input the limiter cannot weigh (a non-integer `max_pages`) is refused;
 *   - a call that cannot get its tokens before its deadline is shed.
 * When BnF answers 429 anyway, the API's bucket is frozen for every agent.
 * Custom app tools pass straight through: the ones that call BnF themselves
 * (`corpus_search`) acquire inside `callBnfTool`.
 *
 * The limiter's config is validated HERE, at build time, whenever this process
 * can reach BnF (BNF_MCP_URL set) or the registry carries the BnF server: a
 * missing BNF_MCP_RATE_* value fails the turn before the model runs, with the
 * variable named, rather than throwing out of `dispatch` mid-loop.
 *
 * An abort during the wait is coerced into an error result exactly as the
 * underlying SDK dispatch coerces an aborted MCP transport (verified in
 * @alien/chat-sdk dist/claude/index.js `callMcpServerTool`: it catches and
 * returns `isError: true`), so the turn runtime sees one behaviour whichever
 * layer the cancellation lands in. Any other limiter failure is logged and
 * returned to the model as an error result; the call is not sent.
 */
export function withBnfRateLimit<TCtx extends ToolContext>(
  registry: ToolRegistry<TCtx>,
): ToolRegistry<TCtx> {
  if (bnfMcpUrlConfigured() || registry.mcpServers.some((s) => s.name === BNF_MCP_SERVER_NAME)) {
    assertBnfRateLimiterConfigured()
  }
  return {
    customTools: registry.customTools,
    mcpServers: registry.mcpServers,
    resolve: (signal) => registry.resolve(signal),
    async dispatch(toolName, input, ctx, toolUseId) {
      const raw = bnfToolFromPrefixed(toolName)
      if (raw === null) return registry.dispatch(toolName, input, ctx, toolUseId)
      if (!isBnfMcpToolName(raw)) {
        console.warn(`[bnf-rate] refused unmapped BnF tool ${toolName} — call not sent`)
        return {
          isError: true,
          content: JSON.stringify(
            bnfCallRefusedResult(
              `L'outil BnF « ${raw} » n'est pas connu du limiteur de débit : il n'a pas été appelé. ` +
                `Outils BnF disponibles : ${BNF_MCP_TOOLS.join(", ")}.`,
            ),
          ),
        }
      }
      let grant
      try {
        grant = await acquireBnfMcp(raw, input, ctx.signal)
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
        const refusal =
          grant.kind === "invalid_input" ? bnfCallRefusedResult(grant.error) : quotaSaturatedResult(grant)
        return { isError: true, content: JSON.stringify(refusal) }
      }
      const result = await registry.dispatch(toolName, input, ctx, toolUseId)
      if (isUpstreamRateLimited(result)) reportBnfUpstreamRateLimit(raw, undefined)
      return result
    },
  }
}
