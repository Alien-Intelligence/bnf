import "server-only"
// models/ingest/policy.ts
// Authorization policy for ingest operations.
// Loaded by lib/bouncer.ts via `bouncer.with(IngestPolicy)`.
import type { User, Project } from "@/lib/generated/prisma/client"

export class IngestPolicy {
  constructor(private user: User) {}

  /**
   * Admins bypass all per-resource checks.
   * Returning `true` short-circuits the named-action check.
   */
  before(u: User): boolean | undefined {
    return u.role === "admin" ? true : undefined
  }

  /** Any member/owner who can see the project may view its ingest jobs. */
  view(project: Project): boolean {
    return project.ownerId === this.user.id || project.isPublic
  }

  /** Only the project owner may submit a new ingestion. */
  submit(project: Project): boolean {
    return project.ownerId === this.user.id
  }

  /** Only the project owner may cancel an in-flight ingestion. */
  cancel(project: Project): boolean {
    return project.ownerId === this.user.id
  }
}
