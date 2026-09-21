// models/corpus/policy.ts
// Authorization rules for corpus operations.
// No DB calls — resources are passed in by the route handler.
// See playbook/api-layers.md for the bouncer contract.

import { canReadProject, canWriteProject } from "@/lib/authz/project-access"
import { isDerived } from "@/lib/authz/corpus-source"
import type { PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"

export class CorpusPolicy {
  constructor(private user: PolicyUser) {}

  /** Owner, admin, any group share, or a public project. */
  read(project: ProjectWithShares): boolean {
    return canReadProject(this.user, project)
  }

  /**
   * Owner, admin, or a `write` group share — AND the project must own its
   * corpus. A derived project reads another project's corpus; mutating it here
   * would silently write to a corpus the caller does not own. The structural
   * condition is repeated in BufferPolicy, IngestPolicy and SessionPolicy: it
   * is the write half of read-only consumption.
   */
  mutate(project: ProjectWithShares): boolean {
    return canWriteProject(this.user, project) && !isDerived(project)
  }
}
