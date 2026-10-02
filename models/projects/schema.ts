// models/projects/schema.ts
// Re-exports the Prisma-generated Project type so business code never
// imports directly from @/lib/generated/prisma/client.

import {
  type Prisma,
  type Project as PrismaProject,
} from "@/lib/generated/prisma/client"
import type { ProjectAccessLevel } from "@/lib/authz/project-access"
import type { WorkspaceStep } from "@/lib/constants"

export type Project = PrismaProject

/**
 * How a project reaches a user's own lists (lib/authz/project-access.ts
 * projectRelation): theirs, shared with one of their groups, public, or none
 * of these (an admin's reach is not a relation).
 */
export const PROJECT_RELATION = {
  OWN: "own",
  SHARED: "shared",
  PUBLIC: "public",
  NONE: "none",
} as const
export type ProjectRelation = (typeof PROJECT_RELATION)[keyof typeof PROJECT_RELATION]

/**
 * The query shape every project-authorization path must use. `shares` is what
 * `projectAccessLevel` reads to resolve group grants; a Project loaded without
 * it would silently deny access to every shared member.
 *
 * `ProjectWithShares` is a structural superset of `Project`, so existing call
 * sites that only need the scalar columns keep compiling unchanged.
 */
export const projectWithShares = {
  include: {
    shares: { select: { id: true, groupId: true, access: true } },
  },
} satisfies Prisma.ProjectDefaultArgs

export type ProjectWithShares = Prisma.ProjectGetPayload<
  typeof projectWithShares
>

/**
 * A project enriched with the cheap stats the projects-list tiles display:
 * `corpusSize` is the membership count of the head version; `isIngested` is
 * whether a version has been successfully indexed. Both derive from the
 * versioning pointers — see playbook/corpus-versioning.md.
 */
export type ProjectListItem = Project & {
  corpusSize: number
  isIngested: boolean
  /** What the requesting user may do with this project. */
  access: ProjectAccessLevel
  /**
   * Whether it is the requesting user's own, shared with one of their groups,
   * or public (lib/authz/project-access.ts projectRelation). "May I open it"
   * is `access`; this is "is it mine", decided on the server.
   */
  relation: ProjectRelation
  /** ProjectPolicy.share for the requesting user: may they share it. */
  mayShare: boolean
  /** workspaceStepsFor: the steps the requesting user may open. */
  steps: readonly WorkspaceStep[]
  /**
   * Whether they may build a research workspace on it: shared with them (a
   * public project is readable, not derivable — NoCorpusGrantError), owning
   * its corpus, and ingested.
   */
  canDerive: boolean
  /** The owner's display name — shown on tiles under « Partagés avec moi ». */
  ownerName: string
  /**
   * The name of the project this one reads its corpus from, or null when it
   * owns its corpus. Set even when the grant has been revoked: a derived
   * project keeps pointing at its source, and naming it is what makes the
   * revoked state legible.
   */
  corpusSourceName: string | null
}


/**
 * A grant as the share dialog renders it: the level plus the group's name.
 * A query shape, so it lives here beside the others rather than next to the
 * service that happens to be its first caller.
 */
export const shareWithGroup = {
  include: {
    group: {
      select: {
        id: true,
        name: true,
        slug: true,
        // How many people the grant reaches, shown in the share dialog.
        _count: { select: { members: true } },
      },
    },
  },
} satisfies Prisma.ProjectShareDefaultArgs

export type ShareWithGroup = Prisma.ProjectShareGetPayload<
  typeof shareWithGroup
> & {
  /** Derived projects reading this project's corpus through this grant. */
  derivedCount: number
}
