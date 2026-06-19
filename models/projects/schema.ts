// models/projects/schema.ts
// Re-exports the Prisma-generated Project type so business code never
// imports directly from @/lib/generated/prisma/client.

import { type Project as PrismaProject } from "@/lib/generated/prisma/client"

export type Project = PrismaProject

/**
 * A project enriched with the cheap stats the projects-list tiles display:
 * `corpusSize` is the membership count of the head version; `isIngested` is
 * whether a version has been successfully indexed. Both derive from the
 * versioning pointers — see playbook/corpus-versioning.md.
 */
export type ProjectListItem = Project & {
  corpusSize: number
  isIngested: boolean
}
