import "server-only"
import type { User } from "@/models/users/schema"
import type { Project } from "@/models/projects/schema"
import type { AppSession } from "./schema"

export type SessionWithProject = { session: AppSession; project: Project }

export class SessionPolicy {
  constructor(private user: User) {}

  before(u: User): boolean | undefined {
    return u.role === "admin" ? true : undefined
  }

  list(project: Project): boolean {
    return project.ownerId === this.user.id || project.isPublic
  }

  create(project: Project): boolean {
    return project.ownerId === this.user.id
  }

  edit({ project }: SessionWithProject): boolean {
    return project.ownerId === this.user.id
  }

  archive({ project }: SessionWithProject): boolean {
    return project.ownerId === this.user.id
  }
}
