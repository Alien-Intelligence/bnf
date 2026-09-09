import "server-only"

import { prisma } from "@/lib/db"
import { projectAccessLevel } from "@/lib/authz/project-access"
import { USER_ROLE, type PolicyUser } from "@/models/users/schema"
import {
  projectWithShares,
  type Project,
  type ProjectListItem,
  type ProjectWithShares,
} from "./schema"

export class ProjectQueries {
  /**
   * The single loader every authorization path uses. It always includes
   * `shares`, because lib/authz/project-access.ts reads them: a Project loaded
   * without its shares would silently deny access to every shared member.
   */
  static async get(id: string): Promise<ProjectWithShares | null> {
    return prisma.project.findUnique({ where: { id }, ...projectWithShares })
  }

  static async listForOwner(ownerId: string): Promise<Project[]> {
    return prisma.project.findMany({
      where: { ownerId },
      orderBy: { createdAt: "desc" },
    })
  }

  /**
   * The projects-list payload: every project the user may see — owned, shared
   * into one of their groups, or public — plus its head-version corpus size,
   * whether it has been ingested, and the level the caller holds on it.
   *
   * Two queries (projects, then a single grouped membership count over all head
   * versions) — no N+1. An admin sees every project, which is what rule 2 of
   * `projectAccessLevel` already implies for the per-row access level.
   */
  static async listVisibleForUserWithStats(
    user: PolicyUser,
  ): Promise<ProjectListItem[]> {
    const visibility =
      user.role === USER_ROLE.ADMIN
        ? {}
        : {
            OR: [
              { ownerId: user.id },
              { isPublic: true },
              { shares: { some: { groupId: { in: user.groupIds } } } },
            ],
          }

    const projects = await prisma.project.findMany({
      where: visibility,
      orderBy: { updatedAt: "desc" },
      include: {
        ...projectWithShares.include,
        owner: { select: { name: true } },
      },
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

    const sizeByVersion = new Map(counts.map((c) => [c.versionId, c._count.ark]))

    return projects.map(({ owner, ...p }) => ({
      ...p,
      corpusSize: p.headVersionId ? (sizeByVersion.get(p.headVersionId) ?? 0) : 0,
      isIngested: p.ingestedVersionId !== null,
      access: projectAccessLevel(user, p),
      ownerName: owner.name,
    }))
  }

  /**
   * How many derived projects read this project's corpus. Non-zero blocks
   * deletion — see ProjectService.delete and the Restrict FK on
   * Project.corpusSourceId.
   */
  static async derivedCount(sourceProjectId: string): Promise<number> {
    return prisma.project.count({ where: { corpusSourceId: sourceProjectId } })
  }

}
