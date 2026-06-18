import "server-only"

import {
  createToolRegistry,
  type ToolContext,
  type ToolLifecycleCall,
  type ToolLifecycleResult,
} from "@alien/chat-sdk/claude"
import { prisma } from "@/lib/db"
import type { Prisma, User } from "@/lib/generated/prisma/client"

/**
 * Minimal pubsub interface. The concrete `TurnPubSub` from
 * `lib/agent/runtime/pubsub` (a parallel commit) satisfies this shape.
 * Typed loosely here so this module compiles independently.
 */
export interface TurnPubSubLike {
  publish(turnId: string, event: unknown): void
}

/**
 * Per-turn tool context threaded into every tool handler.
 *
 * Extends the base `ToolContext` so it satisfies the `TCtx extends ToolContext`
 * constraint on `ToolRegistry`. `request` is kept non-null per the base
 * contract; callers that have no incoming HTTP request should pass a synthetic
 * `Request` (e.g. `new Request("about:blank")`).
 */
export interface TurnScopedCtx extends ToolContext {
  db: typeof prisma
  user: User
  appSessionId: string
  /** The assistant Message.id being constructed for this turn. */
  turnId: string
  /** Alias of `turnId` — kept so either name reads naturally in handlers. */
  turnMessageId: string
  pubsub: TurnPubSubLike
}

export interface BuildTurnRegistryOpts {
  user: User
  appSessionId: string
  /**
   * The assistant Message.id for this turn. Stored as `toolCall.messageId` so
   * every `ToolCall` row traces back to the message that produced it.
   */
  turnId: string
  turnMessageId: string
  /** PubSub instance for broadcasting tool events to connected SSE clients. */
  pubsub: TurnPubSubLike
}

/**
 * Build a turn-scoped tool context for use with `ToolRegistry.dispatch`.
 *
 * Called by the runner for each turn — `request` and `signal` come from the
 * runner's own AbortController and incoming HTTP request (or a synthetic one
 * for server-driven turns).
 */
export function buildTurnScopedCtx(
  opts: BuildTurnRegistryOpts,
  request: Request,
  signal: AbortSignal,
): TurnScopedCtx {
  return {
    signal,
    request,
    db: prisma,
    user: opts.user,
    appSessionId: opts.appSessionId,
    turnId: opts.turnId,
    turnMessageId: opts.turnMessageId,
    pubsub: opts.pubsub,
  }
}

/**
 * Construct a turn-scoped `ToolRegistry`.
 *
 * The registry is intentionally empty (`tools: []`, `mcpServers: []`) — slice
 * 3 adds domain `defineTool` handlers and the BnF MCP server entry. The
 * lifecycle hooks are the load-bearing piece this module ships: they persist
 * every tool invocation to the `ToolCall` table without any event-stream
 * parsing.
 *
 * ## Lifecycle
 * - `onToolStart` — inserts a `ToolCall` row with `status="running"`.
 * - `onToolEnd`   — updates the same row with output, final status, and
 *                   latency. Both writes throw on failure (fail loudly rather
 *                   than silently losing persistence data).
 *
 * ## Usage
 * ```ts
 * const registry = buildTurnScopedRegistry(opts)
 * const ctx = buildTurnScopedCtx(opts, request, signal)
 * // pass registry to runClaudeSdk, pass ctx via the runner's dispatch call
 * ```
 */
export function buildTurnScopedRegistry(opts: BuildTurnRegistryOpts) {
  return createToolRegistry<TurnScopedCtx>({
    tools: [],
    mcpServers: [],

    onToolStart: async (call: ToolLifecycleCall): Promise<void> => {
      if (!call.toolUseId) return
      await prisma.toolCall.create({
        data: {
          id: call.toolUseId,
          messageId: opts.turnMessageId,
          tool: call.toolName,
          input: (call.input ?? {}) as Prisma.InputJsonObject,
          source: call.source,
          serverName: call.serverName ?? null,
          status: "running",
          createdAt: new Date(),
        },
      })
    },

    onToolEnd: async (call: ToolLifecycleCall, result: ToolLifecycleResult): Promise<void> => {
      if (!call.toolUseId) return
      await prisma.toolCall.update({
        where: { id: call.toolUseId },
        data: {
          output: result.content as Prisma.InputJsonValue,
          status: result.isError ? "error" : "ok",
          latencyMs: result.elapsedMs,
          finishedAt: new Date(),
        },
      })
    },
  })
}
