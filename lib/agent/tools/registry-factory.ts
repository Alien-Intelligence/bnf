import "server-only"

import { createToolRegistry, type ToolContext } from "@alien/chat-sdk/claude"
import { prisma } from "@/lib/db"
import { resolveMcpServers } from "./mcp-servers"
import { toolsForScope } from "./index"
import type { User } from "@/lib/generated/prisma/client"

/**
 * Per-turn tool context threaded into every tool handler.
 *
 * Extends the SDK's base `ToolContext` (which now carries `emit` for domain
 * events) so it satisfies the `TCtx extends ToolContext` constraint on
 * `ToolRegistry`. The SDK `TurnRuntime` injects `signal` (the detached turn
 * signal) and `emit` at dispatch time; the rest is built per request by the
 * chat route's `buildToolContext`.
 *
 * Domain tools publish via `ctx.emit?.({ type, data })` — the runtime fans the
 * event onto the same SSE stream. There is no app-level pubsub or turnId here
 * anymore (the runtime owns both).
 */
export interface TurnScopedCtx extends ToolContext {
  db: typeof prisma
  user: User
  appSessionId: string
  /** The project this session belongs to. */
  projectId: string
  /** Whether this is a corpus-building or RAG research session. */
  scope: "corpus" | "research"
}

export interface BuildTurnCtxOpts {
  user: User
  appSessionId: string
  /** The project this session belongs to. */
  projectId: string
  /** Whether this is a corpus-building or RAG research session. */
  scope: "corpus" | "research"
}

/**
 * Build a turn-scoped tool context. The SDK runtime overrides `signal` (with
 * the detached turn signal) and injects `emit`, so the `signal` passed here is
 * only a placeholder for the inline/non-runtime path.
 */
export function buildTurnScopedCtx(
  opts: BuildTurnCtxOpts,
  request: Request,
  signal: AbortSignal,
): TurnScopedCtx {
  return {
    signal,
    request,
    db: prisma,
    user: opts.user,
    appSessionId: opts.appSessionId,
    projectId: opts.projectId,
    scope: opts.scope,
  }
}

/**
 * Construct a turn-scoped `ToolRegistry`.
 *
 * Populates the registry with all app-defined `defineTool` handlers and,
 * when `BNF_MCP_URL` / `BNF_MCP_TOKEN` are present in the environment, the
 * BnF MCP server entry. If the MCP env vars are absent (common in local dev
 * without a live BnF MCP endpoint) the registry still works — corpus, memory,
 * and ingest tools remain functional; the agent just has no BnF search
 * capability for that session.
 *
 * ## Persistence
 * ToolCall rows are persisted by the SDK `TurnRuntime` (it wraps
 * `registry.dispatch` and awaits the adapter's recordToolStart/End in order),
 * NOT by registry lifecycle hooks — see the note in the body.
 *
 * ## Usage
 * ```ts
 * const registry = await buildTurnScopedRegistry(signal)
 * const ctx = buildTurnScopedCtx(opts, request, signal)
 * // pass registry as the SDK handler's per-request `buildTools` result
 * ```
 *
 * `scope` selects the tool BOUNDARY (design item 4): a corpus session registers
 * corpus/buffer/ingest tools; a research session registers rag/note/doc tools;
 * memory + ask_user are shared. See toolsForScope(). Tool-scoped data (user,
 * project, scope) lives on the `TurnScopedCtx` built by `buildTurnScopedCtx`.
 */
export async function buildTurnScopedRegistry(scope: "corpus" | "research", signal?: AbortSignal) {
  // MCP server is optional: if BNF_MCP_URL / BNF_MCP_TOKEN are absent — or the
  // session handshake fails (server down) — the app-defined corpus/memory/
  // ingest tools still work; the agent just has no BnF search capability for
  // this turn. Never crash the dev server.
  const mcpServers = await resolveMcpServers(signal)

  // NOTE: ToolCall persistence is intentionally NOT done via registry lifecycle
  // hooks. The SDK's TurnRuntime owns it — it wraps `registry.dispatch` and
  // awaits the persistence adapter's recordToolStart → tool → recordToolEnd in
  // order (see @alien/chat-sdk/server runtime). The Prisma adapter
  // (lib/agent/persistence/prisma-adapter.ts) writes the ToolCall rows.
  return createToolRegistry<TurnScopedCtx>({
    tools: toolsForScope(scope),
    mcpServers,
  })
}
