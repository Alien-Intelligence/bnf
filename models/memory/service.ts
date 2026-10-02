import "server-only"
import { prisma } from "@/lib/db"
import { PromptBuilder } from "@/lib/agent/prompts/builder"
import { MEMORY_NEAR_DUP_MAX_EDIT_DISTANCE } from "@/lib/constants"
import { MEMORY_ORIGIN, type MemoryItem, type MemoryOrigin, type MemoryScope } from "@/models/memory/schema"

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

/**
 * Every memory change goes through this service, and every one of them
 * invalidates the cached system prompts of ALL the project's sessions IN THE
 * SAME TRANSACTION: each prompt embeds both scopes' memory (Track E Phase 11),
 * so the change and the invalidation commit together or not at all — a failed
 * invalidation can no longer leave a committed fact behind stale prompts. On
 * 0.18.1 memory_write invalidated through a dynamic import that never resolved,
 * and the error was swallowed, so a fact never reached the other sessions'
 * cached prompts.
 */
export class MemoryService {
  /**
   * Upsert a fact. A near-duplicate in the same (scope, section) — equal after
   * normalisation, or fewer than MEMORY_NEAR_DUP_MAX_EDIT_DISTANCE edits away —
   * is merged into (its text replaced) rather than piled up
   * (playbook/memory.md: dedupe is mandatory). Without an origin the fact is
   * recorded as deduced (MEMORY_ORIGIN.DEDUIT), or keeps the merged item's.
   */
  static async write(args: {
    projectId: string
    scope: MemoryScope
    section: string
    text: string
    origin?: MemoryOrigin | null
  }): Promise<MemoryItem> {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.memoryItem.findMany({
        where: { projectId: args.projectId, scope: args.scope, section: args.section },
      })
      const target = norm(args.text)
      const match = existing.find(
        (e) =>
          norm(e.text) === target ||
          levenshtein(norm(e.text), target) < MEMORY_NEAR_DUP_MAX_EDIT_DISTANCE,
      )
      const item = match
        ? await tx.memoryItem.update({
            where: { id: match.id },
            data: { text: args.text, origin: args.origin ?? match.origin ?? MEMORY_ORIGIN.DEDUIT },
          })
        : await tx.memoryItem.create({
            data: {
              projectId: args.projectId,
              scope: args.scope,
              section: args.section,
              text: args.text,
              origin: args.origin ?? MEMORY_ORIGIN.DEDUIT,
              position: existing.length,
            },
          })
      await PromptBuilder.invalidateProject(args.projectId, tx)
      return item
    })
  }

  /**
   * Delete one item of the project's `scope`. Returns false — and invalidates
   * nothing — when no such item exists (wrong id, project or scope): the
   * caller reports "not found" instead of a deletion that did not happen.
   */
  static async forget(projectId: string, scope: MemoryScope, itemId: string): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.memoryItem.deleteMany({ where: { id: itemId, projectId, scope } })
      if (count === 0) return false
      await PromptBuilder.invalidateProject(projectId, tx)
      return true
    })
  }

  /**
   * Create a user-authored memory item (`origin: "user"`), from the memory
   * dialog. It goes through `write`, so a near-duplicate of an existing item
   * in the same section is merged into it like any other write.
   */
  static async createUserItem(args: {
    projectId: string
    scope: MemoryScope
    section: string
    text: string
  }): Promise<MemoryItem> {
    return MemoryService.write({ ...args, origin: MEMORY_ORIGIN.USER })
  }

  /**
   * Update the text and/or section of an existing memory item.
   * Caller must have already verified project ownership (via MemoryPolicy).
   */
  static async update(
    itemId: string,
    args: { text?: string; section?: string },
  ): Promise<MemoryItem> {
    return prisma.$transaction(async (tx) => {
      const item = await tx.memoryItem.update({
        where: { id: itemId },
        data: {
          ...(args.text !== undefined ? { text: args.text } : {}),
          ...(args.section !== undefined ? { section: args.section } : {}),
        },
      })
      await PromptBuilder.invalidateProject(item.projectId, tx)
      return item
    })
  }

  /**
   * Move an item to an absolute position within its section.
   * The caller computes the target position (e.g. current ± 1).
   */
  static async reorder(itemId: string, position: number): Promise<MemoryItem> {
    return prisma.$transaction(async (tx) => {
      const item = await tx.memoryItem.update({ where: { id: itemId }, data: { position } })
      await PromptBuilder.invalidateProject(item.projectId, tx)
      return item
    })
  }
}
