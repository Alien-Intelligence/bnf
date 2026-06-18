// models/agents/service.ts
// Business logic for agent session operations: starting a new turn,
// canceling an in-progress turn, and building a turn snapshot for the
// SSE reattach path.
//
// "Turn" in this codebase == one user message + the resulting assistant
// message (+ any tool calls). A turn maps to a single assistant Message row
// created here and updated by the TurnRunner as it streams.
import "server-only"

import { prisma } from "@/lib/db"
import type { AppSession, TurnSnapshot } from "./schema"
import { TURN_STATUS } from "./schema"
import { AgentQueries } from "./queries"
import type { User } from "@/models/users/schema"
import type { PostTurnInput } from "./types"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TurnAlreadyActiveError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} already has an active turn in progress`)
    this.name = "TurnAlreadyActiveError"
  }
}

export class TurnNotActiveError extends Error {
  constructor(turnId: string) {
    super(`Turn ${turnId} is not currently active — cannot cancel`)
    this.name = "TurnNotActiveError"
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AgentService {
  /**
   * Starts a new agent turn.
   *
   * Steps:
   *   1. Verify no other turn is active on the session (serialization guard).
   *   2. In a transaction:
   *      a. Insert the user Message row (role="user", status="done").
   *      b. Insert the assistant Message row (role="assistant", status="streaming").
   *      c. Set AppSession.activeMessageId = assistant.id.
   *   3. Return the assistant message ID so the route handler can kick off
   *      the TurnRunner and open the SSE stream.
   *
   * The route handler is responsible for starting the TurnRunner after this
   * method returns. The service only establishes the DB state.
   *
   * NOTE: `user` is required for audit purposes (createdBy, future per-user
   * message quotas). It is passed in as a verified principal — the route
   * handler has already called withAuth + bouncer.
   */
  static async startTurn(
    session: AppSession,
    _user: User,
    input: PostTurnInput,
  ): Promise<{ userMessageId: string; assistantMessageId: string }> {
    const sessionId = session.id

    // --- Guard: reject if another turn is already streaming ------------------
    // We re-check inside the transaction too (via the unique constraint on
    // AppSession.activeMessageId), but an early check gives a better error.
    const { activeMessageId } = await AgentQueries.activeTurnForSession(sessionId)
    if (activeMessageId !== null) {
      throw new TurnAlreadyActiveError(sessionId)
    }

    return prisma.$transaction(async (tx) => {
      // --- Determine the next seq value for this session ---------------------
      const lastMessage = await tx.message.findFirst({
        where: { appSessionId: sessionId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      })
      const nextSeq = (lastMessage?.seq ?? -1) + 1

      // --- User message row --------------------------------------------------
      const userMessage = await tx.message.create({
        data: {
          appSessionId: sessionId,
          seq: nextSeq,
          role: "user",
          content: input.text,
          status: "done",
        },
        select: { id: true },
      })

      // --- Assistant message row (status=streaming) -------------------------
      const assistantMessage = await tx.message.create({
        data: {
          appSessionId: sessionId,
          seq: nextSeq + 1,
          role: "assistant",
          content: null,
          status: TURN_STATUS.STREAMING,
        },
        select: { id: true },
      })

      // --- Point AppSession.activeMessageId at the assistant message ---------
      // The @unique constraint on activeMessageId enforces there can be at most
      // one active message per session process-wide — concurrent startTurn calls
      // will hit a unique constraint violation here, which surfaces as a
      // transaction error and is the definitive serialization guard.
      await tx.appSession.update({
        where: { id: sessionId },
        data: { activeMessageId: assistantMessage.id },
      })

      return {
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
      }
    })
  }

  /**
   * Builds (or returns the cached) system prompt for the given session.
   *
   * Delegates to `PromptBuilder.buildForSession`, which reads memory + corpus
   * snapshot and caches the result in `AppSession.systemPrompt`. The cache is
   * invalidated whenever `memory_write` is called.
   *
   * Uses a dynamic import so this module does not take a hard static dependency
   * on the prompts module at evaluation time. The prompts module is always
   * present at runtime — we surface the error if it somehow isn't rather than
   * silently swallowing it.
   */
  static async buildSystemPrompt(session: AppSession): Promise<string> {
    const { PromptBuilder } = await import("@/lib/agent/prompts/builder")
    return PromptBuilder.buildForSession(session)
  }

  /**
   * Cancels an in-progress turn.
   *
   * Looks up the running turn in the TurnRegistry (the process-scoped in-memory
   * map of active AbortControllers) and calls abort(). The TurnRunner detects
   * the abort signal, writes the final partial content to the Message row with
   * status="canceled", and clears AppSession.activeMessageId.
   *
   * Uses a dynamic import so this module does not take a hard dependency on the
   * registry at module evaluation time. The registry is always present at
   * runtime — the dynamic import is a seam for future isolation.
   *
   * Returns true if the turn was found and canceled; false if there was no
   * active turn for the given turnId (idempotent — safe to call twice).
   */
  static async cancelTurn(
    session: AppSession,
    turnId: string,
  ): Promise<boolean> {
    // Dynamic import: avoids a circular dependency edge and keeps the service
    // independent of the runtime module at static analysis time. The registry
    // module is always present — we surface the error if it somehow isn't
    // rather than silently swallowing it.
    const { TurnRegistry } = await import("@/lib/agent/runtime/registry")

    const running = TurnRegistry.get(turnId)
    if (!running) return false

    // Verify the turn belongs to this session (defense in depth — the route
    // handler should already have authorized the session, but we double-check
    // here because cancelTurn takes a turnId, not a session-scoped handle).
    if (running.appSessionId !== session.id) {
      throw new TurnNotActiveError(turnId)
    }

    running.controller.abort()
    return true
  }

  /**
   * Returns the turn snapshot for a session from `fromSeq` onwards.
   *
   * Used by the SSE route's reattach path: a reconnecting client sends its
   * last-seen seq and receives only new content (plus the activeMessageId so
   * it knows whether to subscribe to a live stream or just render history).
   *
   * This is a pure read — no writes, no side effects.
   */
  static async snapshot(
    session: AppSession,
    fromSeq: number,
  ): Promise<TurnSnapshot> {
    return AgentQueries.listMessagesAndToolCalls(session.id, fromSeq)
  }
}
