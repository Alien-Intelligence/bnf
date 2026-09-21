import "server-only"

import { prisma } from "@/lib/db"
import {
  PROJECT_ACCESS_LEVEL,
  projectAccessLevel,
  visibilityScopeFor,
  type ProjectAccess,
} from "@/lib/authz/project-access"
import { canReachCorpus } from "@/lib/authz/corpus-source"
import { CORPUS_VERSION_STATUS } from "@/models/corpus/schema"
import type { PolicyUser } from "@/models/users/schema"
import { ProjectQueries } from "./queries"
import {
  shareWithGroup,
  type Project,
  type ProjectListItem,
  type ProjectWithShares,
  type ShareWithGroup,
} from "./schema"
import type { CreateProjectInput } from "./types"

/**
 * Thrown when the caller holds no group share on the source project. Ownership
 * and the admin role are accepted too, but `isPublic` is deliberately not: a
 * public project is readable, not derivable — deriving pins a workspace to a
 * grant that can later be revoked, and there is no grant to pin to.
 */
export class NoCorpusGrantError extends Error {
  constructor() {
    super("Vous ne disposez d'aucun partage sur ce corpus.")
    this.name = "NoCorpusGrantError"
  }
}

/**
 * Thrown when the source corpus has never been ingested. Deriving from it
 * would produce a workspace that can do nothing at all: the RAG store holds
 * no passages, so every question would come back empty with no way to fix it
 * from inside the derived project.
 */
export class SourceNotIngestedError extends Error {
  constructor() {
    super("Ce corpus n'a pas encore été ingéré ; il n'y a rien à interroger.")
    this.name = "SourceNotIngestedError"
  }
}

/** Thrown when the source is itself a derived project. */
export class SourceIsDerivedError extends Error {
  constructor() {
    super("Ce projet lit déjà le corpus d'un autre projet.")
    this.name = "SourceIsDerivedError"
  }
}

export class ProjectService {
  /**
   * Creates a project and atomically initialises its empty head CorpusVersion
   * (seq=1, status="sealed", parentId=null).
   *
   * Invariant 1 from playbook/corpus-versioning.md: "A project always has a
   * head. If a project has no corpus, head is a sealed empty version
   * (seq=1, total=0). This avoids null checks everywhere."
   *
   * The two writes are wrapped in a single $transaction so the project never
   * exists without a head version and the head pointer never points at nothing.
   */
  static async create(input: CreateProjectInput): Promise<Project> {
    return prisma.$transaction(async (tx) => {
      // 1. Create the project row (headVersionId null initially; updated below).
      const project = await tx.project.create({
        data: {
          name: input.name,
          subtitle: input.subtitle,
          ownerId: input.ownerId,
        },
      })

      // 2. Create the initial empty corpus version (seq=1, sealed, no parent).
      const headVersion = await tx.corpusVersion.create({
        data: {
          projectId: project.id,
          seq: 1,
          status: CORPUS_VERSION_STATUS.SEALED,
          parentId: null,
          createdBy: `user:${input.ownerId}`,
          note: "initial empty corpus",
        },
      })

      // 3. Point the project's headVersionId at the new version.
      //    Done as a separate update so the FK constraint is satisfied
      //    (CorpusVersion must exist before Project can reference it).
      const updated = await tx.project.update({
        where: { id: project.id },
        data: { headVersionId: headVersion.id },
      })

      return updated
    })
  }

  /**
   * Creates a *derived* project: a research workspace whose corpus, documents
   * and cluster dataset are the source's, and whose sessions, memory and notes
   * are its own. Read-only consumption is structural — there is no flag, only
   * `corpusSourceId`.
   *
   * The grant that authorises it is recorded as `corpusSourceShareId`, so
   * revoking the share flips the workspace to the revoked state
   * (onDelete: SetNull) instead of silently emptying its corpus.
   */
  static async createDerived(input: {
    source: ProjectWithShares
    user: PolicyUser
    name: string
    subtitle?: string
  }): Promise<Project> {
    const { source, user } = input

    if (source.corpusSourceId !== null) throw new SourceIsDerivedError()
    if (source.ingestedVersionId === null) throw new SourceNotIngestedError()

    // The share to pin the workspace to. An owner or admin may derive from a
    // project with no share at all, in which case there is nothing to pin —
    // and nothing that could later be revoked.
    const groupIds = new Set(user.groupIds)
    const grant =
      source.shares.find((s) => groupIds.has(s.groupId)) ?? null

    if (
      grant === null &&
      projectAccessLevel(user, source) !== PROJECT_ACCESS_LEVEL.OWNER
    ) {
      throw new NoCorpusGrantError()
    }

    return prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          name: input.name,
          subtitle: input.subtitle,
          ownerId: user.id,
          corpusSourceId: source.id,
          corpusSourceShareId: grant?.id ?? null,
        },
      })

      // A derived project never reads its own head, but corpus-versioning
      // invariant 1 — "a project always has a head" — holds for every project
      // in the table, and honouring it keeps every version query total.
      const headVersion = await tx.corpusVersion.create({
        data: {
          projectId: project.id,
          seq: 1,
          status: CORPUS_VERSION_STATUS.SEALED,
          parentId: null,
          createdBy: `user:${user.id}`,
          note: `derived from project ${source.id}`,
        },
      })

      return tx.project.update({
        where: { id: project.id },
        data: { headVersionId: headVersion.id },
      })
    })
  }
}

/**
 * The projects-list payload: the rows the user may see, each decorated with
 * what they may do with it and the corpus stats its tile shows.
 *
 * The decoration lives here rather than in `queries.ts` because access level
 * and corpus reachability are decisions — `projectAccessLevel` and
 * `canReachCorpus` are the two predicates, and queries.ts holds no
 * authorization logic (playbook/models.md). A derived project's stats come from
 * the source's pointers, and a revoked one reports nothing at all rather than
 * the numbers it used to have.
 */
export async function listProjectsForUser(
  user: PolicyUser,
): Promise<ProjectListItem[]> {
  const rows = await ProjectQueries.listVisibleRows(visibilityScopeFor(user))

  const headIds = [
    ...new Set(
      rows
        .map((p) => p.corpusSource?.headVersionId ?? p.headVersionId)
        .filter((id): id is string => id !== null),
    ),
  ]
  const sizeByVersion = await ProjectQueries.membershipCountByVersion(headIds)

  return rows.map(({ owner, corpusSource, ...p }) => {
    const reachable = canReachCorpus(p)
    const headId = corpusSource?.headVersionId ?? p.headVersionId
    const ingestedId = corpusSource?.ingestedVersionId ?? p.ingestedVersionId

    return {
      ...p,
      corpusSize: reachable && headId ? (sizeByVersion.get(headId) ?? 0) : 0,
      isIngested: reachable && ingestedId !== null,
      access: projectAccessLevel(user, p),
      ownerName: owner.name,
      corpusSourceName: corpusSource?.name ?? null,
    }
  })
}

/** Thrown when a share names a group that does not exist. */
export class GroupNotFoundError extends Error {
  constructor(readonly groupId: string) {
    super("Groupe introuvable.")
    this.name = "GroupNotFoundError"
  }
}

/**
 * The grant layer: who may work on a project beyond its owner. A separate class
 * from ProjectService because sharing is the only operation that widens access
 * and is worth reading in one piece — but the same file, because a domain model
 * is five files and nothing about it is scattered (playbook/models.md).
 */
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
