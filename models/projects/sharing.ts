import "server-only"

// models/projects/sharing.ts
// The grant layer: who may work on a project beyond its owner. Kept separate
// from service.ts, which owns the project lifecycle — sharing is the only
// operation that widens access, and it is worth reading in one place.

import { prisma } from "@/lib/db"
import type { Prisma } from "@/lib/generated/prisma/client"
import type { ProjectAccess } from "@/lib/authz/project-access"
import type { ProjectWithShares } from "./schema"

/** A grant as the share dialog renders it: the level plus the group's name. */
export const shareWithGroup = {
  include: { group: { select: { id: true, name: true, slug: true } } },
} satisfies Prisma.ProjectShareDefaultArgs

export type ShareWithGroup = Prisma.ProjectShareGetPayload<
  typeof shareWithGroup
> & {
  /** Derived projects reading this project's corpus through this grant. */
  derivedCount: number
}

/** Thrown when a share names a group that does not exist. */
export class GroupNotFoundError extends Error {
  constructor(readonly groupId: string) {
    super("Groupe introuvable.")
    this.name = "GroupNotFoundError"
  }
}

export class ProjectSharingService {
  static async list(projectId: string): Promise<ShareWithGroup[]> {
    const shares = await prisma.projectShare.findMany({
      where: { projectId },
      ...shareWithGroup,
      orderBy: { createdAt: "asc" },
    })

    // Revoking a grant costs the derived workspaces built on it their corpus,
    // so the dialog must be able to say how many before the owner clicks.
    const derived = await prisma.project.groupBy({
      by: ["corpusSourceShareId"],
      where: { corpusSourceShareId: { in: shares.map((s) => s.id) } },
      _count: { _all: true },
    })
    const byShare = new Map(
      derived.map((d) => [d.corpusSourceShareId, d._count._all]),
    )

    return shares.map((s) => ({ ...s, derivedCount: byShare.get(s.id) ?? 0 }))
  }

  /**
   * Grants a group access to a project, or changes the level of an existing
   * grant. Upsert on the unique (projectId, groupId) pair: one grant per pair
   * by construction, so "share again at write" is a level change rather than a
   * second, contradictory row.
   */
  static async share(
    project: ProjectWithShares,
    granterId: string,
    input: { groupId: string; access: ProjectAccess },
  ): Promise<ShareWithGroup[]> {
    const group = await prisma.group.findUnique({
      where: { id: input.groupId },
      select: { id: true },
    })
    if (!group) throw new GroupNotFoundError(input.groupId)

    const share = await prisma.projectShare.upsert({
      where: {
        projectId_groupId: { projectId: project.id, groupId: input.groupId },
      },
      create: {
        projectId: project.id,
        groupId: input.groupId,
        access: input.access,
        createdBy: granterId,
      },
      update: { access: input.access },
    })

    // Re-attach workspaces this grant had orphaned. A revoke deletes the share
    // row and nulls the pointer (SetNull); re-sharing creates a NEW row, so
    // without this a revoke could never be undone — the workspace would stay in
    // the revoked state for ever even though its owner demonstrably has access
    // again. Only workspaces reading THIS corpus, currently detached, and owned
    // by a member of the group being granted are re-pointed.
    await prisma.project.updateMany({
      where: {
        corpusSourceId: project.id,
        corpusSourceShareId: null,
        owner: { groupMemberships: { some: { groupId: input.groupId } } },
      },
      data: { corpusSourceShareId: share.id },
    })

    return this.list(project.id)
  }

  /**
   * Revokes a group's access. Any derived project created through this grant
   * survives — its notes and sessions are its own — but flips to the revoked
   * state as `corpus_source_share_id` goes null (onDelete: SetNull). That state
   * is rendered explicitly rather than as an empty corpus; see
   * lib/authz/corpus-source.ts.
   *
   * Revoking a grant that does not exist is a no-op: the caller's intent
   * ("this group has no access") holds either way, and the share dialog can
   * race a second owner session.
   */
  static async unshare(
    projectId: string,
    groupId: string,
  ): Promise<ShareWithGroup[]> {
    await prisma.projectShare.deleteMany({ where: { projectId, groupId } })
    return this.list(projectId)
  }
}
