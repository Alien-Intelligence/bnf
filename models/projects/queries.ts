import "server-only"

import { prisma } from "@/lib/db"
import type { VisibilityScope } from "@/lib/authz/project-access"
import {
  projectWithShares,
  type Project,
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
   * Every project row the user may see — owned, shared into one of their
   * groups, or public — with the owner's name and the corpus pointers a
   * derived project reads from its source.
   *
   * Rows only, and the visibility filter arrives pre-decided as a
   * `VisibilityScope` — this file never sees a user and so cannot re-derive who
   * may see what. The access level and the reachability of a revoked corpus are
   * likewise applied by `listProjectsForUser` in service.ts
   * (playbook/models.md, playbook/sharing.md).
   */
  static async listVisibleRows(scope: VisibilityScope) {
    const where = scope.unrestricted
      ? {}
      : {
          OR: [
            { ownerId: scope.userId },
            { isPublic: true },
            { shares: { some: { groupId: { in: scope.groupIds } } } },
          ],
        }

    return prisma.project.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      include: {
        ...projectWithShares.include,
        owner: { select: { name: true } },
        // The corpus pointers come from the source for a derived project —
        // the same rule corpusProjectId() applies on every other read path.
        corpusSource: {
          select: { name: true, headVersionId: true, ingestedVersionId: true },
        },
      },
    })
  }

  /**
   * Membership counts for a set of corpus versions, in one grouped query so the
   * projects list stays two round trips rather than N+1.
   */
  static async membershipCountByVersion(
    versionIds: string[],
  ): Promise<Map<string, number>> {
    if (versionIds.length === 0) return new Map()
    const counts = await prisma.corpusMembership.groupBy({
      by: ["versionId"],
      where: { versionId: { in: versionIds } },
      _count: { ark: true },
    })
    return new Map(counts.map((c) => [c.versionId, c._count.ark]))
  }

  /** The ids of the projects reading this project's corpus. */
  static async derivedIds(sourceProjectId: string): Promise<string[]> {
    const rows = await prisma.project.findMany({
      where: { corpusSourceId: sourceProjectId },
      select: { id: true },
    })
    return rows.map((r) => r.id)
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
