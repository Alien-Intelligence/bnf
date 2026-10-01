// models/messages/queries.ts
// Pure database access for the persisted transcript (Message + ToolCall).
// Imports only from @/lib/db and ./schema.
import "server-only"

import { prisma } from "@/lib/db"

export class MessageQueries {
  /**
   * How many times `tool` has been called in a session, over every message of
   * that session. Reads the durable `tool_call` rows the runtime persists
   * before a handler runs, so the count includes the call being handled and
   * survives reloads — this is what makes the per-session sub-agent cap
   * (SPAWN_MAX_PER_SESSION) impossible to reset by reopening the page.
   */
  static async countToolCalls(appSessionId: string, tool: string): Promise<number> {
    return prisma.toolCall.count({
      where: { tool, message: { appSessionId } },
    })
  }
}
