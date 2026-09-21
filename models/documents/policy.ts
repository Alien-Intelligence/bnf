// models/documents/policy.ts
// Authorization rules for document operations.
// No DB calls — resources are passed in by the route handler.

import { canReadProject } from "@/lib/authz/project-access"
import type { PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"

export class DocumentPolicy {
  constructor(private user: PolicyUser) {}

  /** Documents are scoped to a project; visibility follows the project. */
  view(project: ProjectWithShares): boolean {
    return canReadProject(this.user, project)
  }
}
