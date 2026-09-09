import {
  canReadProject,
  canWriteProject,
  isProjectOwner,
} from "@/lib/authz/project-access"
import { USER_ROLE, type PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "./schema"

export class ProjectPolicy {
  constructor(private user: PolicyUser) {}

  /** Owner, admin, any group share, or a public project. */
  view(p: ProjectWithShares): boolean {
    return canReadProject(this.user, p)
  }

  /** Any authenticated non-guest user may create a project. */
  create(): boolean {
    return this.user.role !== USER_ROLE.GUEST
  }

  edit(p: ProjectWithShares): boolean {
    return canWriteProject(this.user, p)
  }

  /**
   * Owner-only, deliberately. A `write`-shared collaborator may mutate the
   * corpus, run ingestion and write notes, but may not destroy the project.
   */
  delete(p: ProjectWithShares): boolean {
    return isProjectOwner(this.user, p)
  }

  /**
   * Owner-only, deliberately. Only the owner (or an admin, who resolves to
   * `owner`) may widen access to a project — a write share is a licence to
   * work inside it, not to re-grant it.
   */
  share(p: ProjectWithShares): boolean {
    return isProjectOwner(this.user, p)
  }
}
