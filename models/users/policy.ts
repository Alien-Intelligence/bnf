import type { User } from "./schema"

export class UserPolicy {
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
   * A user may view their own profile only.
   */
  view(target: User): boolean {
    return this.user.id === target.id
  }
}
