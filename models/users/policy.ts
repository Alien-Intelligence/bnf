import { USER_ROLE, type AuthSessionRow, type PolicyUser, type User } from "./schema"

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

  /**
   * A user may end their own session, and only their own: the session withAuth
   * resolved from the cookie must belong to the user it resolved. No admin
   * override — ending someone else's session is not sign-out.
   */
  signOut(session: AuthSessionRow): boolean {
    return session.userId === this.user.id
  }
}
