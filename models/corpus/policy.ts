// models/corpus/policy.ts
// Authorization rules for corpus operations.
// No DB calls — resources are passed in by the route handler.
// See playbook/api-layers.md for the bouncer contract.

import type { User } from "@/models/users/schema"
import type { Project } from "@/models/projects/schema"

export class CorpusPolicy {
  constructor(private user: User) {}

  /**
   * Admin bypass: if the acting user is an admin, every action is allowed.
   * Returns true to short-circuit; undefined to fall through to the action
   * method (per playbook/api-layers.md bouncer contract).
   */
  before(u: User): boolean | undefined {
    if (u.role === "admin") return true
    return undefined
  }

  /**
   * A corpus can be read if the user owns the project or the project is public.
   */
  read(project: Project): boolean {
    return project.ownerId === this.user.id || project.isPublic
  }

  /**
   * Only the project owner may mutate the corpus (add / remove ARKs,
   * trigger ingestion, etc.).
   */
  mutate(project: Project): boolean {
    return project.ownerId === this.user.id
  }
}
