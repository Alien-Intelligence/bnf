import "server-only"

import { prisma } from "@/lib/db"
import { SessionQueries } from "@/models/sessions/queries"
import {
  PROJECT_ACCESS_LEVEL,
  isProjectAccess,
  projectAccessLevel,
  projectRelation,
  adminVisibilityScope,
  personalVisibilityScope,
  type ProjectAccess,
} from "@/lib/authz/project-access"
import { CORPUS_SOURCE_STATE, canReachCorpus, corpusSourceState } from "@/lib/authz/corpus-source"
import { workspaceStepsFor } from "@/lib/authz/workspace-steps"
import { ProjectPolicy } from "./policy"
import { CORPUS_VERSION_STATUS } from "@/models/corpus/schema"
import type { PolicyUser } from "@/models/users/schema"
import { ProjectQueries } from "./queries"
import {
  shareWithGroup,
  type Project,
  type ProjectListItem,
  type ProjectWithShares,
  type ShareWithGroup,
  PROJECT_RELATION,
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
    // Only a recognised level is a grant (isProjectAccess), as everywhere else.
    const grant =
      source.shares.find((s) => groupIds.has(s.groupId) && isProjectAccess(s.access)) ?? null

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
 * A user's own projects list: what they own, plus what has genuinely been shared
 * with them. Each row is decorated with what they may do with it and the corpus
 * stats its tile shows.
 *
 * Scoped with `personalVisibilityScope`, so an **admin sees their own projects
 * here, not everyone's** — org-wide oversight is `listAllProjects` and lives in
 * the admin console. The decoration lives here rather than in `queries.ts`
 * because access level and corpus reachability are decisions
 * (playbook/models.md). A derived project's stats come from the source's
 * pointers, and a revoked one reports nothing at all rather than the numbers it
 * used to have.
 */
export async function listProjectsForUser(
  user: PolicyUser,
): Promise<ProjectListItem[]> {
  const rows = await decorateProjectRows(
    user,
    await ProjectQueries.listVisibleRows(personalVisibilityScope(user)),
  )
  // The personal scope only returns own, validly shared and public rows, and
  // projectRelation is built on the same access table; a row that is none of
  // the three means the two disagree — a bug, raised as such.
  const stray = rows.find((r) => r.relation === PROJECT_RELATION.NONE)
  if (stray) throw new ProjectScopeMismatchError(stray.id, user.id)
  return rows
}

/**
 * Every project in the instance, for the admin console's oversight table.
 *
 * Authorize with `ProjectPolicy.listAll` before calling. A non-admin who
 * reaches it gets their own rows rather than the whole table, so a missing
 * authorize() degrades to the personal list instead of leaking everything.
 */
export async function listAllProjects(
  user: PolicyUser,
): Promise<ProjectListItem[]> {
  return decorateProjectRows(
    user,
    await ProjectQueries.listVisibleRows(adminVisibilityScope(user)),
  )
}

/** Shared decoration for both listings — see `listProjectsForUser`. */
async function decorateProjectRows(
  user: PolicyUser,
  rows: Awaited<ReturnType<typeof ProjectQueries.listVisibleRows>>,
): Promise<ProjectListItem[]> {
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
    const relation = projectRelation(user, p)
    const headId = corpusSource?.headVersionId ?? p.headVersionId
    const ingestedId = corpusSource?.ingestedVersionId ?? p.ingestedVersionId

    return {
      ...p,
      corpusSize: reachable && headId ? (sizeByVersion.get(headId) ?? 0) : 0,
      isIngested: reachable && ingestedId !== null,
      access: projectAccessLevel(user, p),
      relation,
      mayShare: new ProjectPolicy(user).share(p),
      steps: workspaceStepsFor(user, p),
      canDerive:
        relation === PROJECT_RELATION.SHARED &&
        corpusSourceState(p) === CORPUS_SOURCE_STATE.OWN &&
        ingestedId !== null,
      ownerName: owner.name,
      corpusSourceName: corpusSource?.name ?? null,
    }
  })
}

/**
 * The personal listing returned a project that projectRelation says is not
 * the user's, shared with them or public: the visibility scope and the access
 * table disagree.
 */
export class ProjectScopeMismatchError extends Error {
  constructor(
    readonly projectId: string,
    readonly userId: string,
  ) {
    super(`Project ${projectId} is in ${userId}'s list but is not theirs, shared or public`)
    this.name = "ProjectScopeMismatchError"
  }
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
    await prisma.$transaction(async (tx) => {
      const shares = await tx.projectShare.findMany({ where: { projectId, groupId }, select: { id: true } })
      // The workspaces derived through this grant flip to the revoked state:
      // their cached prompts still say the corpus is readable, so they are
      // dropped in the same transaction — before the delete, while
      // corpus_source_share_id still names the share (onDelete: SetNull).
      await SessionQueries.invalidateDerivedThroughShares(
        shares.map((s) => s.id),
        tx,
      )
      await tx.projectShare.deleteMany({ where: { projectId, groupId } })
    })
    return this.list(projectId)
  }
}
