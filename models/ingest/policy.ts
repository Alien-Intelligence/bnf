import "server-only"
// models/ingest/policy.ts
// Authorization policy for ingest operations.
// Loaded by lib/bouncer.ts via `bouncer.with(IngestPolicy)`.
import { canReadProject, canWriteProject } from "@/lib/authz/project-access"
import { isDerived } from "@/lib/authz/corpus-source"
import type { PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"

export class IngestPolicy {
  constructor(private user: PolicyUser) {}

  /** Anyone who can see the project may view its ingest jobs. */
  view(project: ProjectWithShares): boolean {
    return canReadProject(this.user, project)
  }

  /**
   * Submitting indexes the corpus into the cluster — a corpus mutation in all
   * but name, so it needs write access on a project that owns its corpus.
   */
  submit(project: ProjectWithShares): boolean {
    return canWriteProject(this.user, project) && !isDerived(project)
  }

  cancel(project: ProjectWithShares): boolean {
    return canWriteProject(this.user, project) && !isDerived(project)
  }
}
