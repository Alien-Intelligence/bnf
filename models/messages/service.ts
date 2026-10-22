import "server-only"

import { USAGE_EXPORT_WINDOW_MS } from "@/lib/constants"
import { ProjectQueries } from "@/models/projects/queries"
import type { ProjectUsageTotals } from "./schema"
import { messageUsageSchema } from "./types"

export class MessageService {
  /**
   * Per-project token totals, all-time and over the `USAGE_EXPORT_WINDOW_MS`
   * ending at `now`. A message without usage (user turns, interrupted
   * assistant turns) counts toward neither the totals nor the message count.
   */
  static async projectUsageTotals(now: Date): Promise<ProjectUsageTotals[]> {
    const since = new Date(now.getTime() - USAGE_EXPORT_WINDOW_MS)
    const projects = await ProjectQueries.listWithMessageUsage()

    return projects.map((p) => {
      const totals: ProjectUsageTotals = {
        projectId: p.id,
        projectName: p.name,
        ownerId: p.ownerId,
        ownerEmail: p.owner.email,
        tokensIn: 0,
        tokensOut: 0,
        messageCount: 0,
        windowTokensIn: 0,
        windowTokensOut: 0,
      }
      for (const session of p.appSessions) {
        for (const msg of session.messages) {
          if (msg.usage === null) continue
          const usage = messageUsageSchema.parse(msg.usage)
          const tokIn = usage.inputTokens ?? 0
          const tokOut = usage.outputTokens ?? 0
          totals.tokensIn += tokIn
          totals.tokensOut += tokOut
          totals.messageCount += 1
          if (msg.createdAt >= since) {
            totals.windowTokensIn += tokIn
            totals.windowTokensOut += tokOut
          }
        }
      }
      return totals
    })
  }
}
