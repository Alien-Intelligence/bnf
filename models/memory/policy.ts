import "server-only"
import type { User, Project } from "@/lib/generated/prisma/client"

export class MemoryPolicy {
  constructor(private user: User) {}

  before(u: User): true | undefined {
    return u.role === "admin" ? true : undefined
  }

  read(project: Project): boolean {
    return project.ownerId === this.user.id || project.isPublic
  }

  write(project: Project): boolean {
    return project.ownerId === this.user.id
  }

  forget(project: Project): boolean {
    return project.ownerId === this.user.id
  }
}
