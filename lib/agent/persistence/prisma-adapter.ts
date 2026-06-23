// lib/agent/persistence/prisma-adapter.ts
// BnF's implementation of the SDK's storage-agnostic `ChatPersistenceAdapter`
// (@alien/chat-sdk/persistence) against the existing AppSession / Message /
// ToolCall schema. This is the ONLY place that maps the SDK's durable-turn
// contract onto BnF's Postgres tables — the SDK runtime drives these methods.
//
// The mapping mirrors what the bespoke lib/agent/runtime/persistence.ts did,
// but behind the SDK's awaited/ordered contract instead of fire-and-forget
// hooks. A "turn" is one assistant Message row (turnId == Message.id); the
// paired user Message is created in beginTurn. AppSession.activeMessageId is
// the serialization guard (one streaming turn per session) and the reattach
// pointer.
import "server-only"

import type {
  BeginTurnInput,
  ChatPersistenceAdapter,
  PersistedTurnRef,
  ServerSnapshot,
  SnapshotTurn,
  ToolCallEnd,
  ToolCallStart,
  TurnFinal,
} from "@alien/chat-sdk/persistence"
import { Prisma } from "@/lib/generated/prisma/client"
import { prisma } from "@/lib/db"
import { AgentQueries } from "@/models/agents/queries"
import { SessionService } from "@/models/sessions/service"

/** Narrow BnF's free-form Message.role / status to the SDK's closed unions. */
function toSnapshotRole(role: string): SnapshotTurn["role"] {
  return role === "user" ? "user" : "assistant"
}
function toSnapshotStatus(status: string): SnapshotTurn["status"] {
  switch (status) {
    case "streaming":
    case "error":
    case "canceled":
      return status
    default:
      // "done", "draft", or anything unexpected → treat as a settled turn.
      return "done"
  }
}
function toToolStatus(status: string): "running" | "ok" | "error" {
  return status === "running" ? "running" : status === "error" ? "error" : "ok"
}

export function createPrismaChatAdapter(): ChatPersistenceAdapter {
  return {
    /**
     * Create the user + assistant Message rows and point activeMessageId at the
     * assistant turn — the same transaction as AgentService.startTurn. The
     * @unique constraint on activeMessageId is the definitive serialization
     * guard: a concurrent beginTurn for the same session fails the transaction.
     */
    async beginTurn(input: BeginTurnInput): Promise<PersistedTurnRef> {
      const sessionId = input.sessionId
      const { ref, isFirstMessage } = await prisma.$transaction(async (tx) => {
        const lastMessage = await tx.message.findFirst({
          where: { appSessionId: sessionId },
          orderBy: { seq: "desc" },
          select: { seq: true },
        })
        const nextSeq = (lastMessage?.seq ?? -1) + 1

        await tx.message.create({
          data: {
            appSessionId: sessionId,
            seq: nextSeq,
            role: "user",
            content: input.userMessage.content,
            status: "done",
          },
          select: { id: true },
        })

        const assistant = await tx.message.create({
          data: {
            appSessionId: sessionId,
            seq: nextSeq + 1,
            role: "assistant",
            content: null,
            status: "streaming",
          },
          select: { id: true },
        })

        await tx.appSession.update({
          where: { id: sessionId },
          data: { activeMessageId: assistant.id },
        })

        return {
          ref: { turnId: assistant.id, seq: nextSeq + 1 },
          isFirstMessage: nextSeq === 0,
        }
      })

      // First user message of the session → auto-name it from that message.
      // Fired after the transaction commits (so the message row exists) and
      // deliberately NOT awaited: naming is a cosmetic enhancement that must
      // never block or fail the turn. A failure leaves the placeholder title.
      if (isFirstMessage) {
        void SessionService.maybeAutoTitle(sessionId, input.userMessage.content).catch(
          (err) => {
            console.error(`[auto-title] session ${sessionId} naming failed:`, err)
          },
        )
      }

      return ref
    },

    async appendContent(turnId: string, content: string): Promise<void> {
      await prisma.message.update({ where: { id: turnId }, data: { content } })
    },

    async recordToolStart(turnId: string, call: ToolCallStart): Promise<void> {
      await prisma.toolCall.create({
        data: {
          id: call.toolUseId,
          messageId: turnId,
          tool: call.toolName,
          source: call.source,
          serverName: call.serverName ?? null,
          input: call.input as Prisma.InputJsonValue,
          status: "running",
        },
      })
    },

    async recordToolEnd(_turnId: string, call: ToolCallEnd): Promise<void> {
      await prisma.toolCall.update({
        where: { id: call.toolUseId },
        data: {
          // Preserve the existing {content} shape the UI / synthetic-event
          // derivation reads.
          output: { content: call.output } as Prisma.InputJsonValue,
          status: call.isError ? "error" : "ok",
          latencyMs: Math.round(call.elapsedMs),
          finishedAt: new Date(),
        },
      })
    },

    // recordDomainEvent is intentionally omitted: BnF derives domain state
    // (corpus/memory/note chips) from ToolCall rows and live `ctx.emit` events,
    // so there is nothing to persist separately. Leaving it undefined tells the
    // runtime not to attempt a write.

    async endTurn(turnId: string, final: TurnFinal): Promise<void> {
      await prisma.$transaction([
        prisma.message.update({
          where: { id: turnId },
          data: {
            content: final.content,
            status: "done",
            finishedAt: new Date(),
            ...(final.usage
              ? { usage: final.usage as unknown as Prisma.InputJsonValue }
              : {}),
          },
        }),
        prisma.appSession.updateMany({
          where: { activeMessageId: turnId },
          data: { activeMessageId: null },
        }),
      ])
    },

    async failTurn(turnId: string, error: string): Promise<void> {
      // Content was already flushed via appendContent; only the terminal state
      // changes here.
      await prisma.$transaction([
        prisma.message.update({
          where: { id: turnId },
          data: { status: "error", error, finishedAt: new Date() },
        }),
        prisma.appSession.updateMany({
          where: { activeMessageId: turnId },
          data: { activeMessageId: null },
        }),
      ])
    },

    async cancelTurn(turnId: string, content: string): Promise<void> {
      await prisma.$transaction([
        prisma.message.update({
          where: { id: turnId },
          data: { content, status: "canceled", finishedAt: new Date() },
        }),
        prisma.appSession.updateMany({
          where: { activeMessageId: turnId },
          data: { activeMessageId: null },
        }),
      ])
    },

    async getActiveTurn(sessionId: string): Promise<PersistedTurnRef | null> {
      const session = await prisma.appSession.findUnique({
        where: { id: sessionId },
        select: { activeMessageId: true },
      })
      if (!session?.activeMessageId) return null
      const message = await prisma.message.findUnique({
        where: { id: session.activeMessageId },
        select: { seq: true },
      })
      return message ? { turnId: session.activeMessageId, seq: message.seq } : null
    },

    async loadSnapshot(input: {
      sessionId: string
      cursor?: number
    }): Promise<ServerSnapshot> {
      // cursor is the highest seq already seen; fetch strictly-newer turns.
      const fromSeq = input.cursor != null ? input.cursor + 1 : 0
      const snap = await AgentQueries.listMessagesAndToolCalls(input.sessionId, fromSeq)

      const turns: SnapshotTurn[] = snap.messages.map((m) => {
        const toolCalls = snap.toolCalls
          .filter((tc) => tc.messageId === m.id)
          .map((tc) => ({
            toolUseId: tc.id,
            toolName: tc.tool,
            source: (tc.source === "mcp" ? "mcp" : "custom") as "custom" | "mcp",
            serverName: tc.serverName ?? undefined,
            input: (tc.input ?? {}) as Record<string, unknown>,
            output: tc.output,
            isError: tc.status === "error",
            elapsedMs: tc.latencyMs ?? undefined,
            status: toToolStatus(tc.status),
          }))
        return {
          turnId: m.id,
          seq: m.seq,
          role: toSnapshotRole(m.role),
          content: m.content ?? "",
          status: toSnapshotStatus(m.status),
          toolCalls,
        }
      })

      const cursor = turns.reduce((max, t) => Math.max(max, t.seq), input.cursor ?? -1)
      return { turns, activeTurnId: snap.activeMessageId, cursor }
    },
  }
}
