// models/agents/queries.ts
// Pure database access for the agents model. No business logic, no external
// calls, no transforms beyond what Prisma returns.
// Imports only from @/lib/db and ./schema.
import "server-only"

import { prisma } from "@/lib/db"
import type { Project } from "@/models/projects/schema"
import type { AppSession, TurnSnapshot } from "./schema"

// ---------------------------------------------------------------------------
// Composite type returned by getAppSessionWithProject
// ---------------------------------------------------------------------------

/**
 * AppSession with its parent Project pre-loaded.
 * Used by route handlers that must pass { session, project } to AgentPolicy
 * methods — policy methods never fetch, so the project must be loaded by the
 * handler before the authorize() call.
 */
export type AppSessionWithProject = AppSession & { project: Project }

export class AgentQueries {
  /**
   * Returns the activeMessageId for an AppSession — the ID of the currently
   * streaming Message row, or null when the session is idle.
   * Used by the SSE route to decide whether to subscribe to an in-flight turn.
   */
  static async activeTurnForSession(
    appSessionId: string,
  ): Promise<{ activeMessageId: string | null }> {
    const session = await prisma.appSession.findUniqueOrThrow({
      where: { id: appSessionId },
      select: { activeMessageId: true },
    })
    return { activeMessageId: session.activeMessageId }
  }

  /**
   * Returns all messages (with their tool calls) for a session, starting from
   * `fromSeq` inclusive, sorted by seq ascending.
   *
   * `fromSeq` defaults to 0 (full history). Pass the client's last-seen seq + 1
   * to receive only new content (SSE reattach scenario).
   *
   * The snapshot also includes the session's `activeMessageId` so the caller
   * can check idleness without a second query.
   */
  static async listMessagesAndToolCalls(
    appSessionId: string,
    fromSeq: number,
  ): Promise<TurnSnapshot> {
    const [session, messages] = await Promise.all([
      prisma.appSession.findUniqueOrThrow({
        where: { id: appSessionId },
        select: { activeMessageId: true },
      }),
      prisma.message.findMany({
        where: {
          appSessionId,
          seq: { gte: fromSeq },
        },
        orderBy: { seq: "asc" },
        select: {
          id: true,
          seq: true,
          role: true,
          content: true,
          thinking: true,
          status: true,
          error: true,
          model: true,
          startedAt: true,
          finishedAt: true,
          createdAt: true,
          toolCalls: {
            select: {
              id: true,
              messageId: true,
              tool: true,
              input: true,
              output: true,
              status: true,
              source: true,
              serverName: true,
              latencyMs: true,
              error: true,
              createdAt: true,
              finishedAt: true,
            },
            orderBy: { createdAt: "asc" },
          },
        },
      }),
    ])

    // Flatten tool calls from nested messages into the top-level toolCalls array.
    const toolCalls = messages.flatMap((m) => m.toolCalls)
    const messagesWithoutToolCalls = messages.map(({ toolCalls: _, ...msg }) => msg)

    return {
      messages: messagesWithoutToolCalls,
      toolCalls,
      activeMessageId: session.activeMessageId,
    }
  }

  /**
   * Fetches a single AppSession by ID, or null if not found.
   * Used by the route handler to load the resource for the policy check.
   */
  static async getAppSession(id: string): Promise<AppSession | null> {
    return prisma.appSession.findUnique({ where: { id } })
  }

  /**
   * Fetches an AppSession together with its parent Project, or null if not
   * found. Used by route handlers whose policy check requires both the session
   * and the project (AgentPolicy methods take { session, project }).
   */
  static async getAppSessionWithProject(
    id: string,
  ): Promise<AppSessionWithProject | null> {
    const row = await prisma.appSession.findUnique({
      where: { id },
      include: { project: true },
    })
    return row
  }

  /**
   * Fetches the full AppSession by ID, throwing if not found.
   * Used by the service when the session is guaranteed to exist (already
   * loaded and authorized by the handler).
   */
  static async getAppSessionOrThrow(id: string): Promise<AppSession> {
    return prisma.appSession.findUniqueOrThrow({ where: { id } })
  }
}
