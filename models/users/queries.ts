import "server-only"

import { prisma } from "@/lib/db"
import type { AdminAccountStat, User } from "./schema"

export class UserQueries {
  static async get(id: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } })
  }

  static async getByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email } })
  }

  /**
   * Every account with its per-account activity totals, for the admin console.
   * Owner-scoped: a user's stats aggregate the projects they own (and the
   * sessions / messages / notes within them), plus the feedback they authored.
   * Shared by the accounts GET route and its CSV export so the two never drift.
   *
   * Demo-scale aggregation: one project fetch carrying the nested message usage
   * (mirrors the usage route), one feedback groupBy. No per-user N+1.
   */
  static async listWithAdminStats(): Promise<AdminAccountStat[]> {
    const [users, projects, feedbackByUser] = await Promise.all([
      prisma.user.findMany({ orderBy: { createdAt: "desc" } }),

      prisma.project.findMany({
        select: {
          ownerId: true,
          _count: { select: { notes: true } },
          appSessions: {
            select: {
              messages: { select: { usage: true, createdAt: true } },
            },
          },
        },
      }),

      prisma.feedback.groupBy({
        by: ["userId"],
        _count: { _all: true },
      }),
    ])

    type Acc = {
      projectCount: number
      sessionCount: number
      messageCount: number
      noteCount: number
      tokensIn: number
      tokensOut: number
      lastActiveAt: Date | null
    }
    const byOwner = new Map<string, Acc>()

    for (const p of projects) {
      const acc = byOwner.get(p.ownerId) ?? {
        projectCount: 0,
        sessionCount: 0,
        messageCount: 0,
        noteCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        lastActiveAt: null,
      }
      acc.projectCount += 1
      acc.noteCount += p._count.notes
      acc.sessionCount += p.appSessions.length

      for (const session of p.appSessions) {
        for (const msg of session.messages) {
          acc.messageCount += 1
          const usage = msg.usage as
            | { inputTokens?: number; outputTokens?: number }
            | null
          if (usage) {
            acc.tokensIn += usage.inputTokens ?? 0
            acc.tokensOut += usage.outputTokens ?? 0
          }
          if (!acc.lastActiveAt || msg.createdAt > acc.lastActiveAt) {
            acc.lastActiveAt = msg.createdAt
          }
        }
      }

      byOwner.set(p.ownerId, acc)
    }

    const feedbackCount = new Map(
      feedbackByUser.map((f) => [f.userId, f._count._all]),
    )

    return users.map((u) => {
      const acc = byOwner.get(u.id)
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        createdAt: u.createdAt.toISOString(),
        projectCount: acc?.projectCount ?? 0,
        sessionCount: acc?.sessionCount ?? 0,
        messageCount: acc?.messageCount ?? 0,
        noteCount: acc?.noteCount ?? 0,
        feedbackGiven: feedbackCount.get(u.id) ?? 0,
        tokensIn: acc?.tokensIn ?? 0,
        tokensOut: acc?.tokensOut ?? 0,
        lastActiveAt: acc?.lastActiveAt ? acc.lastActiveAt.toISOString() : null,
      }
    })
  }
}
