import "server-only"
import { prisma } from "@/lib/db"
import type { MemoryItem } from "@/lib/generated/prisma/client"

const NEAR_DUP_THRESHOLD = 4 // Levenshtein

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ")
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[m][n]
}

export class MemoryService {
  static async write(args: {
    projectId: string
    scope: string
    section: string
    text: string
    origin?: string | null
  }): Promise<MemoryItem> {
    const existing = await prisma.memoryItem.findMany({
      where: { projectId: args.projectId, scope: args.scope, section: args.section },
    })
    const target = norm(args.text)
    const match = existing.find(
      (e) => norm(e.text) === target || levenshtein(norm(e.text), target) < NEAR_DUP_THRESHOLD,
    )
    if (match) {
      return prisma.memoryItem.update({
        where: { id: match.id },
        data: { text: args.text, origin: args.origin ?? match.origin ?? "deduit" },
      })
    }
    const position = existing.length
    return prisma.memoryItem.create({
      data: {
        projectId: args.projectId,
        scope: args.scope,
        section: args.section,
        text: args.text,
        origin: args.origin ?? "deduit",
        position,
      },
    })
  }

  static async forget(projectId: string, scope: string, itemId: string): Promise<void> {
    await prisma.memoryItem.deleteMany({ where: { id: itemId, projectId, scope } })
  }
}
