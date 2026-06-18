/**
 * GET /api/admin/usage
 *
 * Returns aggregate token and tool-call statistics for the admin dashboard.
 * Admin-only route — the access gate is enforced inline (not via a Policy)
 * because this is a flat role check, not a per-resource ownership decision.
 *
 * Response shape: AdminUsageResponse
 */
import { withAuth } from "@/app/api/_middleware"
import { forbidden, ok } from "@/lib/api-response"
import { prisma } from "@/lib/db"

/** Token aggregate for a single project. */
export type ProjectUsageStat = {
  id: string
  name: string
  ownerId: string
  tokens: { in: number; out: number }
  messageCount: number
  lastWeekTokens: { in: number; out: number }
}

/** Tool call frequency entry. */
export type ToolFrequencyEntry = {
  tool: string
  count: number
}

/** Full response body. */
export type AdminUsageResponse = {
  since: string
  projects: ProjectUsageStat[]
  toolFrequency: ToolFrequencyEntry[]
}

export const GET = withAuth(async (_req, user) => {
  // Admin-only — not a per-resource policy; a flat role gate.
  if (user.role !== "admin") return forbidden()

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000)

  const [projects, toolCallRows] = await Promise.all([
    prisma.project.findMany({
      select: {
        id: true,
        name: true,
        ownerId: true,
        appSessions: {
          select: {
            messages: {
              select: { usage: true, createdAt: true },
            },
          },
        },
      },
    }),

    // Tool-call frequency over the last 7 days.
    // `tool` is the field name in the ToolCall model.
    prisma.toolCall.groupBy({
      by: ["tool"],
      where: { createdAt: { gte: since } },
      _count: { tool: true },
      orderBy: { _count: { tool: "desc" } },
    }),
  ])

  // Reduce message.usage JSON into token sums.
  const projectStats: ProjectUsageStat[] = projects.map((p) => {
    let allIn = 0
    let allOut = 0
    let weekIn = 0
    let weekOut = 0
    let messageCount = 0

    for (const session of p.appSessions) {
      for (const msg of session.messages) {
        const usage = msg.usage as { inputTokens?: number; outputTokens?: number } | null
        if (!usage) continue
        const tokIn = usage.inputTokens ?? 0
        const tokOut = usage.outputTokens ?? 0
        allIn += tokIn
        allOut += tokOut
        messageCount += 1
        if (msg.createdAt >= since) {
          weekIn += tokIn
          weekOut += tokOut
        }
      }
    }

    return {
      id: p.id,
      name: p.name,
      ownerId: p.ownerId,
      tokens: { in: allIn, out: allOut },
      messageCount,
      lastWeekTokens: { in: weekIn, out: weekOut },
    }
  })

  const toolFrequency: ToolFrequencyEntry[] = toolCallRows.map((r) => ({
    tool: r.tool,
    count: r._count.tool,
  }))

  return ok<AdminUsageResponse>({
    since: since.toISOString(),
    projects: projectStats,
    toolFrequency,
  })
})
