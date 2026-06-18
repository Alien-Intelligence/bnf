import "server-only"
import { prisma } from "@/lib/db"
import type { MemoryItem } from "@/lib/generated/prisma/client"
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

  static async get(id: string): Promise<MemoryItem | null> {
    return prisma.memoryItem.findUnique({ where: { id } })
  }
}
