import type { User, Project, Note } from "@/lib/generated/prisma/client"

export class NotePolicy {
  constructor(private user: User) {}

  before(u: User): true | undefined {
    return u.role === "admin" ? true : undefined
  }

  list(project: Project): boolean {
    return project.ownerId === this.user.id || project.isPublic
  }

  read(project: Project, _note?: Note): boolean {
    return this.list(project)
  }

  create(project: Project): boolean {
    return project.ownerId === this.user.id
  }

  update(project: Project, _note: Note): boolean {
    return project.ownerId === this.user.id
  }

  delete(project: Project, _note: Note): boolean {
    return project.ownerId === this.user.id
  }
}
