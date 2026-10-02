import "server-only"
import { prisma } from "@/lib/db"
import { SESSION_SCOPE } from "./schema"
import type { AppSession } from "./schema"

export class SessionQueries {
  /**
   * Drops the cached system prompt on every research session of these projects,
   * so the next turn rebuilds it. Only the research scope carries ingest
   * status; a corpus prompt embeds the head snapshot, which an ingestion does
   * not move. Bumps `promptEpoch` like every invalidation, so a render already
   * in flight cannot cache a prompt from before the ingestion
   * (PromptBuilder.buildForSession's compare-and-set).
   */
  static async clearResearchPrompts(projectIds: string[]): Promise<void> {
    await prisma.appSession.updateMany({
      where: { projectId: { in: projectIds }, scope: SESSION_SCOPE.RESEARCH },
      data: { systemPrompt: null, promptEpoch: { increment: 1 } },
    })
  }

  static async listForProject(projectId: string, scope: string): Promise<AppSession[]> {
    return prisma.appSession.findMany({
      where: { projectId, scope, status: { not: "archived" } },
      orderBy: { updatedAt: "desc" },
    })
  }

  static async get(id: string): Promise<AppSession | null> {
    return prisma.appSession.findUnique({ where: { id } })
  }
}
