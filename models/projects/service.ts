import "server-only"

import { prisma } from "@/lib/db"
import {
  PROJECT_ACCESS_LEVEL,
  projectAccessLevel,
} from "@/lib/authz/project-access"
import type { PolicyUser } from "@/models/users/schema"
import type { Project, ProjectWithShares } from "./schema"
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
          status: "sealed",
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
          status: "sealed",
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
