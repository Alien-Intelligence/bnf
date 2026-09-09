import "server-only"

import { prisma } from "@/lib/db"
import { projectAccessLevel } from "@/lib/authz/project-access"
import { canReachCorpus } from "@/lib/authz/corpus-source"
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
        // The corpus pointers come from the source for a derived project —
        // the same rule corpusProjectId() applies on every other read path.
        corpusSource: {
          select: { name: true, headVersionId: true, ingestedVersionId: true },
        },
      },
    })

    // A derived project's tile must show the corpus it actually reads, so the
    // count is taken over the source's head, not its own empty placeholder.
    const headIds = [
      ...new Set(
        projects
          .map((p) => p.corpusSource?.headVersionId ?? p.headVersionId)
          .filter((id): id is string => id !== null),
      ),
    ]

    const counts =
      headIds.length === 0
        ? []
        : await prisma.corpusMembership.groupBy({
            by: ["versionId"],
            where: { versionId: { in: headIds } },
            _count: { ark: true },
          })

    const sizeByVersion = new Map(counts.map((c) => [c.versionId, c._count.ark]))

    return projects.map(({ owner, corpusSource, ...p }) => {
      // A revoked workspace can no longer reach the corpus it points at, so it
      // reports nothing rather than the stats it used to have.
      const reachable = canReachCorpus(p)
      const headId = corpusSource?.headVersionId ?? p.headVersionId
      const ingestedId = corpusSource?.ingestedVersionId ?? p.ingestedVersionId

      return {
        ...p,
        corpusSize:
          reachable && headId ? (sizeByVersion.get(headId) ?? 0) : 0,
        isIngested: reachable && ingestedId !== null,
        access: projectAccessLevel(user, p),
        ownerName: owner.name,
        corpusSourceName: corpusSource?.name ?? null,
      }
    })
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
