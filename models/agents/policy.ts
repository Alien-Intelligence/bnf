// models/agents/policy.ts
// Authorization rules for agent session operations.
// No DB calls — resources are passed in by the route handler.
// See playbook/api-layers.md for the bouncer contract.

import { canReadProject, canWriteProject } from "@/lib/authz/project-access"
import type { PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"
import type { AppSession } from "./schema"

type SessionResource = { session: AppSession; project: ProjectWithShares }

export class AgentPolicy {
  constructor(private user: PolicyUser) {}

  /**
   * A session can be read (history fetch, reattach) by anyone who can read the
   * project it belongs to. `resource.project` is pre-loaded by the route
   * handler — policy methods never fetch.
   */
  read({ project }: SessionResource): boolean {
    return canReadProject(this.user, project)
  }

  /**
   * Starting a turn creates Message rows and kicks off a streaming SSE
   * response — a write operation in all senses, so it needs write access.
   *
   * There is no corpus-source condition here: a derived project's *research*
   * sessions are legitimate, and it never owns a corpus session (SessionPolicy
   * .create refuses one, and the tool registry would not carry corpus tools
   * anyway).
   */
  post({ project }: SessionResource): boolean {
    return canWriteProject(this.user, project)
  }

  cancel({ project }: SessionResource): boolean {
    return canWriteProject(this.user, project)
  }

  /** Opening the SSE stream is read-only access. Mirrors `read`. */
  stream({ project }: SessionResource): boolean {
    return canReadProject(this.user, project)
  }
}
