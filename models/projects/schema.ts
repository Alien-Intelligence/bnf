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
}

