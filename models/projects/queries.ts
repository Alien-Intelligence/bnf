import "server-only"

import { prisma } from "@/lib/db"
import type { Project, ProjectListItem } from "./schema"

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

  /**
   * The projects-list payload: each project plus its head-version corpus size
   * and whether it has been ingested. Two queries (projects, then a single
   * grouped membership count over all head versions) — no N+1.
   */
  static async listForOwnerWithStats(
    ownerId: string,
  ): Promise<ProjectListItem[]> {
    const projects = await prisma.project.findMany({
      where: { ownerId },
      orderBy: { updatedAt: "desc" },
    })

    const headIds = projects
      .map((p) => p.headVersionId)
      .filter((id): id is string => id !== null)

    const counts =
      headIds.length === 0
        ? []
        : await prisma.corpusMembership.groupBy({
            by: ["versionId"],
            where: { versionId: { in: headIds } },
            _count: { ark: true },
          })

    const sizeByVersion = new Map(
      counts.map((c) => [c.versionId, c._count.ark]),
    )

    return projects.map((p) => ({
      ...p,
      corpusSize: p.headVersionId
        ? (sizeByVersion.get(p.headVersionId) ?? 0)
        : 0,
      isIngested: p.ingestedVersionId !== null,
    }))
  }
}
