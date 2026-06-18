import "server-only"
import { prisma } from "@/lib/db"
import type { AppSession } from "./schema"

export class SessionQueries {
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
