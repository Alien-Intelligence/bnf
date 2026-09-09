import { USER_ROLE, type PolicyUser, type User } from "./schema"

/**
 * Not project-scoped, so it does not route through
 * lib/authz/project-access.ts; it carries its own explicit admin check (the
 * `before()` bypass was removed from every policy in Phase 0).
 */
export class UserPolicy {
  constructor(private user: PolicyUser) {}

  /** A user may view their own profile; an admin may view any. */
  view(target: User): boolean {
    return this.user.role === USER_ROLE.ADMIN || this.user.id === target.id
  }
}
