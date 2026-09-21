import { canReadProject, canWriteProject } from "@/lib/authz/project-access"
import type { PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"
import type { Note } from "@/lib/generated/prisma/client"

/**
 * Notes belong to the project that holds them, never to the corpus source: a
 * derived project's carnet is its own. No corpus-source condition here.
 */
export class NotePolicy {
  constructor(private user: PolicyUser) {}

  list(project: ProjectWithShares): boolean {
    return canReadProject(this.user, project)
  }

  read(project: ProjectWithShares, _note?: Note): boolean {
    return this.list(project)
  }

  create(project: ProjectWithShares): boolean {
    return canWriteProject(this.user, project)
  }

  update(project: ProjectWithShares, _note: Note): boolean {
    return canWriteProject(this.user, project)
  }

  delete(project: ProjectWithShares, _note: Note): boolean {
    return canWriteProject(this.user, project)
  }
}
