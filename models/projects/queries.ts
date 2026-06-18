import "server-only"

import { prisma } from "@/lib/db"
import type { Project } from "./schema"

export class ProjectQueries {
  static async get(id: string): Promise<Project | null> {
    return prisma.project.findUnique({ where: { id } })
  }

  static async listForOwner(ownerId: string): Promise<Project[]> {
    return prisma.project.findMany({
      where: { ownerId },
      orderBy: { createdAt: "desc" },
    })
  }
}
