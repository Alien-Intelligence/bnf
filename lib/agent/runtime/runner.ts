// lib/agent/runtime/runner.ts
// Server-only turn runner.
//
// Wraps runClaudeSdk from @alien/chat-sdk/claude so that every turn:
//   1. Uses the detached AbortController signal (NOT request.signal).
//   2. Persists ChatEvents to the database as they arrive.
//   3. Publishes every event to the TurnPubSub channel so SSE subscribers
//      receive them in real-time.
//   4. Emits heartbeat events during long-running tool calls to keep SSE
//      proxies from closing silent connections.
//
// The runner does NOT construct the ToolRegistry — that is the caller's
// responsibility (the route or a higher-level service) so that tool context
// (db, user, session) can be wired up correctly per the playbook.

import "server-only"

import {
  runClaudeSdk,
  type ToolRegistry,
  type ToolContext,
  type ToolLifecycleCall,
  type ToolLifecycleResult,
} from "@alien/chat-sdk/claude"
import type { ChatMessage } from "@alien/chat-sdk"
import { env } from "@/lib/env"
import { AGENT_MODEL, AGENT_MAX_ITERATIONS } from "@/lib/constants"
import { TurnRegistry } from "./registry"
import { TurnPubSub } from "./pubsub"
import {
  persistMessageStart,
  persistMessageEnd,
  persistMessageError,
  persistMessageCanceled,
  persistUsage,
  flushMessageContent,
  persistToolCallStart,
  persistToolCallEnd,
} from "./persistence"
import { finalizeTurn } from "./finalize"
import type { AppEvent } from "./types"

// ---------------------------------------------------------------------------
// Flush tuning
// ---------------------------------------------------------------------------

/** Flush accumulated text to DB after this many characters to bound data loss
 *  on crash.  250 ms timer is handled separately via setInterval. */
const FLUSH_CHAR_THRESHOLD = 800

/** Interval (ms) between periodic content flushes during streaming. */
const FLUSH_INTERVAL_MS = 250

/** Interval (ms) between heartbeat events published to the SSE channel.
 *  Keeps the connection alive during long-running MCP tool calls. */
const HEARTBEAT_INTERVAL_MS = 10_000

// ---------------------------------------------------------------------------
// ExecuteTurnOptions
// ---------------------------------------------------------------------------

export interface ExecuteTurnOptions<TCtx extends ToolContext = ToolContext> {
  /** The assistant Message.id being built — also used as the turnId key. */
  messageId: string
  /** The AppSession the turn belongs to. */
  appSessionId: string
  /** Pre-built message history including the current user message. */
  messages: ChatMessage[]
  /** Composed system prompt for this turn. */
  system: string
  /** Tool registry — constructed by the caller with full BnF context. */
  tools: ToolRegistry<TCtx>
  /** Tool context — constructed by the caller, same shape as the registry. */
  toolContext: TCtx
}

// ---------------------------------------------------------------------------
// executeTurn
// ---------------------------------------------------------------------------

/**
 * Run one agent turn end-to-end.
 *
 * - Reads the detached AbortController from TurnRegistry (must be registered
 *   before calling this function).
 * - Drives runClaudeSdk, persisting events and publishing them to pubsub.
 * - Calls finalizeTurn on completion, regardless of outcome.
 * - Unregisters the turn from TurnRegistry on exit.
 *
 * This function MUST NOT be `await`-ed from an HTTP handler — the caller
 * should fire it with `setImmediate` or `queueMicrotask` so the HTTP
 * response returns before the runner starts.
 */
export async function executeTurn<TCtx extends ToolContext = ToolContext>(
  opts: ExecuteTurnOptions<TCtx>,
): Promise<void> {
  const { messageId, appSessionId, messages, system, tools, toolContext } = opts

  const turn = TurnRegistry.get(messageId)
  if (!turn) {
    // Should never happen — the caller registers before firing.
    console.error(
      `[runner] executeTurn called for unregistered turn ${messageId}`,
    )
    return
  }

  const signal = turn.controller.signal

  // Accumulated text since last flush
  let textBuffer = ""
  // Total text written so far (used for final flush)
  let totalContent = ""

  // Track whether message-end landed so finalizeTurn knows the outcome
  let messageEndLanded = false
  let errorLanded = false
  let _errorMessage = ""

  // ---------------------------------------------------------------------------
  // Periodic flush timer — flushes content to DB every FLUSH_INTERVAL_MS
  // ---------------------------------------------------------------------------
  let lastFlushedContent = ""

  const flushTimer = setInterval(async () => {
    const snapshot = totalContent
    if (snapshot !== lastFlushedContent) {
      lastFlushedContent = snapshot
      try {
        await flushMessageContent(messageId, snapshot)
      } catch (err) {
        console.error(`[runner] flush error for turn ${messageId}:`, err)
      }
    }
  }, FLUSH_INTERVAL_MS)

  // ---------------------------------------------------------------------------
  // Heartbeat timer — keeps SSE connection alive during long tool calls
  // ---------------------------------------------------------------------------
  const heartbeatTimer = setInterval(() => {
    const heartbeat: AppEvent = { type: "heartbeat", data: {} }
    TurnPubSub.publish(messageId, heartbeat)
  }, HEARTBEAT_INTERVAL_MS)

  // ---------------------------------------------------------------------------
  // Tool lifecycle hooks — wired into a wrapper registry adapter
  // ---------------------------------------------------------------------------
  // We can't mutate the passed ToolRegistry directly, so we instrument at the
  // Prisma layer by wrapping onToolStart/onToolEnd via a proxy.  The registry
  // already accepts lifecycle hooks at construction time; here we perform the
  // DB writes that the runner.ts layer owns.
  //
  // NOTE: The caller passes the registry with their own onToolStart/onToolEnd
  // hooks for business logic.  This runner adds an additional persistence
  // layer on top by wrapping the registry's dispatch method.  We do this
  // transparently by decorating the ToolRegistry object.

  const instrumentedTools = instrumentToolRegistry(tools, messageId)

  // ---------------------------------------------------------------------------
  // Main event loop
  // ---------------------------------------------------------------------------
  try {
    const generator = runClaudeSdk({
      apiKey: env.ANTHROPIC_API_KEY,
      messages,
      system,
      tools: instrumentedTools,
      toolContext,
      model: AGENT_MODEL,
      maxToolTurns: AGENT_MAX_ITERATIONS,
      signal,
    })

    for await (const event of generator) {
      // Publish every event to SSE subscribers
      TurnPubSub.publish(messageId, event)

      // Persist by event type
      switch (event.type) {
        case "message-start":
          await persistMessageStart(messageId, event)
          break

        case "text-delta":
          textBuffer += event.text
          totalContent += event.text
          // Flush at character threshold to avoid holding too much in memory
          if (textBuffer.length >= FLUSH_CHAR_THRESHOLD) {
            lastFlushedContent = totalContent
            textBuffer = ""
            await flushMessageContent(messageId, totalContent)
          }
          break

        case "usage":
          await persistUsage(messageId, event)
          break

        case "message-end":
          messageEndLanded = true
          await persistMessageEnd(messageId, appSessionId, totalContent, event)
          break

        case "error":
          errorLanded = true
          _errorMessage = event.message
          await persistMessageError(
            messageId,
            appSessionId,
            totalContent,
            event.message,
            event.at,
          )
          break

        default:
          // thinking-delta, tool-call-*, tool-result-delta, tool-result,
          // instance-*, response-id, agent-registry, job-id, cost-breakdown
          // — no DB write needed at this layer.
          break
      }
    }
  } catch (err: unknown) {
    // Unexpected exception from the generator (network error, SDK bug, etc.)
    if (!errorLanded && !messageEndLanded) {
      const message =
        err instanceof Error ? err.message : "Unknown runner error"
      console.error(`[runner] turn ${messageId} threw:`, err)
      try {
        await persistMessageError(
          messageId,
          appSessionId,
          totalContent,
          message,
          Date.now(),
        )
      } catch (persistErr) {
        console.error(
          `[runner] failed to persist error for turn ${messageId}:`,
          persistErr,
        )
      }
      const errorEvent: AppEvent = {
        type: "error",
        at: Date.now(),
        message,
      }
      TurnPubSub.publish(messageId, errorEvent)
    }
  } finally {
    clearInterval(flushTimer)
    clearInterval(heartbeatTimer)

    // Detect cancellation: generator stopped without message-end or error
    if (!messageEndLanded && !errorLanded) {
      if (signal.aborted) {
        try {
          await persistMessageCanceled(messageId, appSessionId, totalContent)
        } catch (err) {
          console.error(
            `[runner] failed to persist cancellation for turn ${messageId}:`,
            err,
          )
        }
      } else {
        // Generator exhausted without a terminal event (max iterations hit)
        try {
          await persistMessageEnd(
            messageId,
            appSessionId,
            totalContent,
            { type: "message-end", at: Date.now(), stopReason: "max_iterations" },
          )
        } catch (err) {
          console.error(
            `[runner] failed to persist max-iterations end for turn ${messageId}:`,
            err,
          )
        }
      }
    }

    // Emit the synthetic terminal events and unregister
    await finalizeTurn(messageId, appSessionId, signal.aborted)
    TurnRegistry.unregister(messageId)
  }
}

// ---------------------------------------------------------------------------
// Internal: instrument ToolRegistry to add persistence hooks
// ---------------------------------------------------------------------------

/**
 * Wrap the ToolRegistry's dispatch method to persist ToolCall rows.
 * This is additive — any hooks the caller configured on the registry still
 * fire; we add DB writes on top.
 */
function instrumentToolRegistry<TCtx extends ToolContext>(
  registry: ToolRegistry<TCtx>,
  messageId: string,
): ToolRegistry<TCtx> {
  const originalDispatch = registry.dispatch.bind(registry)

  return {
    ...registry,
    async dispatch(
      toolName: string,
      input: Record<string, unknown>,
      ctx: TCtx,
      toolUseId?: string,
    ) {
      const call: ToolLifecycleCall = {
        toolName,
        input,
        // Determine source from the tool name prefix convention
        source: toolName.includes("__") ? "mcp" : "custom",
        serverName: toolName.includes("__")
          ? toolName.split("__")[0]
          : undefined,
        toolUseId,
      }

      const startMs = Date.now()
      try {
        await persistToolCallStart(messageId, call)
      } catch (err) {
        console.error(`[runner] persistToolCallStart failed for ${toolName}:`, err)
      }

      const result = await originalDispatch(toolName, input, ctx, toolUseId)

      const lifecycleResult: ToolLifecycleResult = {
        content: result.content,
        isError: result.isError,
        elapsedMs: Date.now() - startMs,
      }
      try {
        await persistToolCallEnd(call, lifecycleResult)
      } catch (err) {
        console.error(`[runner] persistToolCallEnd failed for ${toolName}:`, err)
      }

      return result
    },
  }
}
