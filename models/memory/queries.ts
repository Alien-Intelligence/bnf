import "server-only"
import { prisma } from "@/lib/db"
import type { MemoryItem, Prisma } from "@/lib/generated/prisma/client"
import type { MemorySnapshot } from "./schema"

export class MemoryQueries {
  static async snapshot(projectId: string, scope: string): Promise<MemorySnapshot> {
    const items = await prisma.memoryItem.findMany({
      where: { projectId, scope },
      orderBy: [{ section: "asc" }, { position: "asc" }, { createdAt: "asc" }],
    })
    const map = new Map<string, MemoryItem[]>()
    for (const it of items) {
      const arr = map.get(it.section) ?? []
      arr.push(it)
      map.set(it.section, arr)
    }
    return { sections: [...map].map(([title, its]) => ({ title, items: its })) }
  }

  /**
   * Serialise every memory write of one (project, scope) for the rest of the
   * transaction `tx`: a transaction-scoped Postgres advisory lock, so two
   * concurrent writes (a parent turn and its sub-agents) cannot both miss each
   * other's near-duplicate or take the same position.
   */
  static async lockScope(tx: Prisma.TransactionClient, projectId: string, scope: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`memory:${projectId}:${scope}`}))`
  }

  static async get(id: string): Promise<MemoryItem | null> {
    return prisma.memoryItem.findUnique({ where: { id } })
  }
}
