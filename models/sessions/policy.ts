import "server-only"
import { canReadProject, canWriteProject } from "@/lib/authz/project-access"
import { isDerived } from "@/lib/authz/corpus-source"
import type { PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"
import { SESSION_SCOPE, type AppSession, type SessionScope } from "./schema"

export type SessionWithProject = {
  session: AppSession
  project: ProjectWithShares
}

export class SessionPolicy {
  constructor(private user: PolicyUser) {}

  list(project: ProjectWithShares): boolean {
    return canReadProject(this.user, project)
  }

  /**
   * Creating a session needs write access. A corpus-scope session additionally
   * requires a project that owns its corpus: a derived project must never own
   * one, because a corpus session carries the buffer/ingest tools (see
   * lib/agent/tools — the tool-boundary half of read-only consumption).
   */
  create(resource: ProjectWithShares | { project: ProjectWithShares; scope: SessionScope }): boolean {
    const project = "project" in resource ? resource.project : resource
    const scope = "scope" in resource ? resource.scope : null

    if (!canWriteProject(this.user, project)) return false
    if (scope === SESSION_SCOPE.CORPUS && isDerived(project)) return false
    return true
  }

  edit({ project }: SessionWithProject): boolean {
    return canWriteProject(this.user, project)
  }

  archive({ project }: SessionWithProject): boolean {
    return canWriteProject(this.user, project)
  }
}
