// lib/agent/runtime/history.ts
// Server-only helper that loads persisted Message rows and builds the
// ChatMessage[] array the runClaudeSdk runner expects as its `messages` arg.
//
// Only "user" and "assistant" roles are included.  "event" rows are
// internal bookkeeping and must be excluded from the model's history.
// The current assistant Message (the one being streamed) is excluded via
// excludeMessageId so the runner starts from a clean slate.

import "server-only"

import type { ChatMessage } from "@alien/chat-sdk"
import { prisma } from "@/lib/db"

/**
 * Build the message history for a turn.
 *
 * @param appSessionId  The chat session whose history to load.
 * @param excludeMessageId  The id of the assistant Message being written on
 *   this turn — exclude it so the runner's first response goes into it.
 */
export async function buildTurnHistory(
  appSessionId: string,
  excludeMessageId: string,
): Promise<ChatMessage[]> {
  const rows = await prisma.message.findMany({
    where: {
      appSessionId,
      role: { in: ["user", "assistant"] },
      id: { not: excludeMessageId },
    },
    orderBy: { seq: "asc" },
    select: { role: true, content: true },
  })

  // Rows with null content (e.g. a canceled assistant turn that wrote nothing)
  // are excluded — the model cannot use an empty assistant message in history.
  const messages: ChatMessage[] = []
  for (const row of rows) {
    if (!row.content) continue
    if (row.role !== "user" && row.role !== "assistant") continue
    messages.push({ role: row.role, content: row.content })
  }

  return messages
}
