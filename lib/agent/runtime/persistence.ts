// lib/agent/runtime/persistence.ts
// Server-only helpers that translate ChatEvents into database writes.
//
// The TurnRunner calls these inline inside its `for await` loop.  Each
// function is a thin DB write — no business logic lives here.  Business
// logic (e.g. which events to persist) lives in runner.ts.

import "server-only"

import type { ChatEvent } from "@alien/chat-sdk/events"
import type { ToolLifecycleCall, ToolLifecycleResult } from "@alien/chat-sdk/claude"
import { Prisma } from "@/lib/generated/prisma/client"
import { prisma } from "@/lib/db"

// ---------------------------------------------------------------------------
// Message-level writes
// ---------------------------------------------------------------------------

/** Record the Anthropic model id on the Message row when message-start lands. */
export async function persistMessageStart(
  messageId: string,
  event: ChatEvent & { type: "message-start" },
): Promise<void> {
  await prisma.message.update({
    where: { id: messageId },
    data: {
      startedAt: new Date(event.at),
    },
  })
}

/** Flush accumulated assistant text to the Message content column.
 *
 * Called at periodic flush boundaries (every ~200 tokens or 250 ms) and
 * unconditionally at message-end.  Concurrent flushes are safe because
 * Prisma serializes writes to the same row. */
export async function flushMessageContent(
  messageId: string,
  content: string,
): Promise<void> {
  await prisma.message.update({
    where: { id: messageId },
    data: { content },
  })
}

/** Persist token usage when the `usage` event arrives. */
export async function persistUsage(
  messageId: string,
  event: ChatEvent & { type: "usage" },
): Promise<void> {
  const usageJson: Prisma.InputJsonValue = {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
  }
  await prisma.message.update({
    where: { id: messageId },
    data: { usage: usageJson },
  })
}

/** Mark the Message as done and clear AppSession.activeMessageId. */
export async function persistMessageEnd(
  messageId: string,
  appSessionId: string,
  finalContent: string,
  event: ChatEvent & { type: "message-end" },
): Promise<void> {
  await prisma.$transaction([
    prisma.message.update({
      where: { id: messageId },
      data: {
        content: finalContent,
        status: "done",
        finishedAt: new Date(event.at),
      },
    }),
    prisma.appSession.update({
      where: { id: appSessionId },
      data: { activeMessageId: null },
    }),
  ])
}

/** Mark the Message as errored and clear AppSession.activeMessageId. */
export async function persistMessageError(
  messageId: string,
  appSessionId: string,
  finalContent: string,
  errorMessage: string,
  at: number,
): Promise<void> {
  await prisma.$transaction([
    prisma.message.update({
      where: { id: messageId },
      data: {
        content: finalContent,
        status: "error",
        error: errorMessage,
        finishedAt: new Date(at),
      },
    }),
    prisma.appSession.update({
      where: { id: appSessionId },
      data: { activeMessageId: null },
    }),
  ])
}

/** Mark the Message as canceled (signal aborted) and clear the pointer. */
export async function persistMessageCanceled(
  messageId: string,
  appSessionId: string,
  finalContent: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.message.update({
      where: { id: messageId },
      data: {
        content: finalContent,
        status: "canceled",
        finishedAt: new Date(),
      },
    }),
    prisma.appSession.update({
      where: { id: appSessionId },
      data: { activeMessageId: null },
    }),
  ])
}

// ---------------------------------------------------------------------------
// ToolCall writes — called from registry lifecycle hooks
// ---------------------------------------------------------------------------

/** Insert a ToolCall row when a tool dispatch begins. */
export async function persistToolCallStart(
  messageId: string,
  call: ToolLifecycleCall,
): Promise<void> {
  const id = call.toolUseId
  if (!id) return // toolUseId is optional in the type; skip if absent

  const inputJson: Prisma.InputJsonValue =
    call.input as Prisma.InputJsonValue

  await prisma.toolCall.create({
    data: {
      id,
      messageId,
      tool: call.toolName,
      source: call.source,
      serverName: call.serverName ?? null,
      input: inputJson,
      status: "running",
    },
  })
}

/** Update the ToolCall row when a tool dispatch completes. */
export async function persistToolCallEnd(
  call: ToolLifecycleCall,
  result: ToolLifecycleResult,
): Promise<void> {
  const id = call.toolUseId
  if (!id) return

  const outputJson: Prisma.InputJsonValue = { content: result.content }

  await prisma.toolCall.update({
    where: { id },
    data: {
      output: outputJson,
      status: result.isError ? "error" : "ok",
      latencyMs: Math.round(result.elapsedMs),
      finishedAt: new Date(),
    },
  })
}
