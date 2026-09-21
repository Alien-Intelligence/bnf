// models/projects/schema.ts
// Re-exports the Prisma-generated Project type so business code never
// imports directly from @/lib/generated/prisma/client.

import {
  type Prisma,
  type Project as PrismaProject,
} from "@/lib/generated/prisma/client"
import type { ProjectAccessLevel } from "@/lib/authz/project-access"

export type Project = PrismaProject

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
  include: { group: { select: { id: true, name: true, slug: true } } },
} satisfies Prisma.ProjectShareDefaultArgs

export type ShareWithGroup = Prisma.ProjectShareGetPayload<
  typeof shareWithGroup
> & {
  /** Derived projects reading this project's corpus through this grant. */
  derivedCount: number
}
