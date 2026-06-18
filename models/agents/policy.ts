// models/agents/policy.ts
// Authorization rules for agent session operations.
// No DB calls — resources are passed in by the route handler.
// See playbook/api-layers.md for the bouncer contract.

import type { User } from "@/models/users/schema"
import type { Project } from "@/models/projects/schema"
import type { AppSession } from "./schema"

export class AgentPolicy {
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
   * A session can be read (history fetch, reattach) if the user owns the
   * project the session belongs to, or the project is public.
   *
   * `resource.project` is the Project the session belongs to (pre-loaded by
   * the route handler — policy methods never fetch).
   */
  read(resource: { session: AppSession; project: Project }): boolean {
    return (
      resource.project.ownerId === this.user.id || resource.project.isPublic
    )
  }

  /**
   * A new turn can be submitted only by the project owner.
   * Starting a turn creates Message rows and kicks off a streaming SSE
   * response — a write operation in all senses.
   */
  post(resource: { session: AppSession; project: Project }): boolean {
    return resource.project.ownerId === this.user.id
  }

  /**
   * An in-progress turn can be canceled only by the project owner.
   */
  cancel(resource: { session: AppSession; project: Project }): boolean {
    return resource.project.ownerId === this.user.id
  }

  /**
   * An SSE stream can be opened by anyone who can read the session — the
   * project owner, or any user if the project is public.
   * Mirrors the `read` policy: stream access is read-only access.
   */
  stream(resource: { session: AppSession; project: Project }): boolean {
    return (
      resource.project.ownerId === this.user.id || resource.project.isPublic
    )
  }
}
