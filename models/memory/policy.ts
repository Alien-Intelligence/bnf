import "server-only"
import { canReadProject, canWriteProject } from "@/lib/authz/project-access"
import type { PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"

/**
 * Project memory is local to the project that owns it — a derived project has
 * its own memory, so there is no corpus-source condition here.
 */
export class MemoryPolicy {
  constructor(private user: PolicyUser) {}

  read(project: ProjectWithShares): boolean {
    return canReadProject(this.user, project)
  }

  write(project: ProjectWithShares): boolean {
    return canWriteProject(this.user, project)
  }

  forget(project: ProjectWithShares): boolean {
    return canWriteProject(this.user, project)
  }
}
