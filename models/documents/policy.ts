// models/documents/policy.ts
// Authorization rules for document operations.
// No DB calls — resources are passed in by the route handler.

import type { User } from "@/models/users/schema"
import type { Project } from "@/models/projects/schema"

export class DocumentPolicy {
  constructor(private user: User) {}

  /**
   * Admin bypass: if the acting user is an admin, every action is allowed.
   */
  before(u: User): boolean | undefined {
    if (u.role === "admin") return true
    return undefined
  }

  /**
   * A document can be viewed if the user owns the project or the project is
   * public. Documents are scoped to a project; visibility follows the project.
   */
  view(project: Project): boolean {
    return project.ownerId === this.user.id || project.isPublic
  }
}
