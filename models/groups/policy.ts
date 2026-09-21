import type { PolicyUser } from "@/models/users/schema"
import { USER_ROLE } from "@/models/users/schema"
import type { Group } from "./schema"

/**
 * Groups are admin-managed. GroupPolicy is not project-scoped, so it does not
 * route through lib/authz/project-access.ts; it carries its own explicit admin
 * check (the `before()` bypass was removed from every policy in Phase 0).
 */
export class GroupPolicy {
  constructor(private user: PolicyUser) {}

  /** Create, rename, delete, and membership changes are admin-only. */
  manage(): boolean {
    return this.user.role === USER_ROLE.ADMIN
  }

  /**
   * Any authenticated non-guest may list groups — a project owner needs the
   * list to know what they can share into. WHICH groups come back is the
   * visibility scope's job (`adminVisibilityScope`), not this method's: an admin
   * gets all of them, everyone else only their own.
   */
  list(): boolean {
    return this.user.role !== USER_ROLE.GUEST
  }

  /** A member may see their own group's roster; an admin may see any. */
  view(group: Group): boolean {
    return this.manage() || this.user.groupIds.includes(group.id)
  }
}
