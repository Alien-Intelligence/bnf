/**
 * GET /api/admin/usage/export
 *
 * Streams a CSV file of per-project token usage (all-time + last-7-days).
 * Admin-only — same flat role gate as /api/admin/usage.
 */
import { withAuth } from "@/app/api/_middleware"
import { forbidden } from "@/lib/api-response"
import { prisma } from "@/lib/db"

/** Escape a single CSV cell value (RFC 4180). */
function csvCell(value: string | number): string {
  const str = String(value)
  // Wrap in quotes if the value contains comma, newline, or double-quote.
  if (str.includes('"') || str.includes(",") || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function csvRow(cells: (string | number)[]): string {
  return cells.map(csvCell).join(",")
}

export const GET = withAuth(async (_req, user) => {
  // Admin-only — flat role gate (not a per-resource ownership decision).
  if (user.role !== "admin") return forbidden()

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000)

  const projects = await prisma.project.findMany({
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
  })

  const rows: string[] = [
    csvRow([
      "project_id",
      "project_name",
      "owner_id",
      "tokens_in",
      "tokens_out",
      "message_count",
      "last_week_tokens_in",
      "last_week_tokens_out",
    ]),
  ]

  for (const p of projects) {
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

    rows.push(csvRow([p.id, p.name, p.ownerId, allIn, allOut, messageCount, weekIn, weekOut]))
  }

  const csv = rows.join("\r\n") + "\r\n"

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="usage.csv"',
      "Cache-Control": "no-store",
    },
  })
})
