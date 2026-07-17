/**
 * GET /api/admin/overview
 *
 * Global platform statistics for the admin console landing tab: headline
 * totals, the 30-day signup trend, and the feedback distribution. Admin-only —
 * the access gate is a flat role check enforced inline (not a per-resource
 * Policy), matching /api/admin/usage.
 *
 * Response shape: AdminOverviewResponse
 */
import { withAuth } from "@/app/api/_middleware"
import { forbidden, ok } from "@/lib/api-response"
import { prisma } from "@/lib/db"

/** Headline counts across the whole platform. */
export type AdminOverviewTotals = {
  users: number
  projects: number
  sessions: number
  messages: number
  notes: number
  feedback: number
  tokensIn: number
  tokensOut: number
}

/** One day of the signup trend. `date` is an ISO calendar day (YYYY-MM-DD). */
export type SignupDay = { date: string; count: number }

/** A count keyed by feedback rating or target discriminator. */
export type FeedbackBucket = { key: string; count: number }

export type AdminOverviewResponse = {
  totals: AdminOverviewTotals
  newUsersLast30d: number
  signupsByDay: SignupDay[]
  feedbackByRating: FeedbackBucket[]
  feedbackByTarget: FeedbackBucket[]
}

const WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1_000

/** ISO calendar day (UTC) for a Date — the key used to bucket signups. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export const GET = withAuth(async (_req, user) => {
  // Admin-only — flat role gate (not a per-resource ownership decision).
  if (user.role !== "admin") return forbidden()

  const windowStart = new Date(Date.now() - WINDOW_DAYS * DAY_MS)

  const [
    userCount,
    projectCount,
    sessionCount,
    noteCount,
    feedbackCount,
    messages,
    recentUsers,
    ratingRows,
    targetRows,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.project.count(),
    prisma.appSession.count(),
    prisma.note.count(),
    prisma.feedback.count(),
    // Token sums live in each message's usage JSON — not summable in SQL, so we
    // reduce in memory. `messages.length` is the platform-wide message total.
    prisma.message.findMany({ select: { usage: true } }),
    prisma.user.findMany({
      where: { createdAt: { gte: windowStart } },
      select: { createdAt: true },
    }),
    prisma.feedback.groupBy({ by: ["rating"], _count: { _all: true } }),
    prisma.feedback.groupBy({ by: ["target"], _count: { _all: true } }),
  ])

  let tokensIn = 0
  let tokensOut = 0
  for (const msg of messages) {
    const usage = msg.usage as
      | { inputTokens?: number; outputTokens?: number }
      | null
    if (!usage) continue
    tokensIn += usage.inputTokens ?? 0
    tokensOut += usage.outputTokens ?? 0
  }

  // Pre-seed every day in the window so the trend has no gaps for the chart.
  const buckets = new Map<string, number>()
  for (let i = 0; i < WINDOW_DAYS; i += 1) {
    buckets.set(isoDay(new Date(windowStart.getTime() + i * DAY_MS)), 0)
  }
  for (const u of recentUsers) {
    const key = isoDay(u.createdAt)
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  const signupsByDay: SignupDay[] = Array.from(buckets.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return ok<AdminOverviewResponse>({
    totals: {
      users: userCount,
      projects: projectCount,
      sessions: sessionCount,
      messages: messages.length,
      notes: noteCount,
      feedback: feedbackCount,
      tokensIn,
      tokensOut,
    },
    newUsersLast30d: recentUsers.length,
    signupsByDay,
    feedbackByRating: ratingRows.map((r) => ({
      key: r.rating,
      count: r._count._all,
    })),
    feedbackByTarget: targetRows.map((r) => ({
      key: r.target,
      count: r._count._all,
    })),
  })
})
