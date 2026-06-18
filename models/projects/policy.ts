import type { User } from "@/models/users/schema"
import type { Project } from "./schema"

export class ProjectPolicy {
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

  /** Owner or public projects are visible to any authenticated user. */
  view(p: Project): boolean {
    return p.ownerId === this.user.id || p.isPublic
  }

  /** Any authenticated non-guest user may create a project. */
  create(): boolean {
    return this.user.role !== "guest"
  }

  /** Only the project owner may edit. */
  edit(p: Project): boolean {
    return p.ownerId === this.user.id
  }

  /** Only the project owner may delete. */
  delete(p: Project): boolean {
    return p.ownerId === this.user.id
  }
}
