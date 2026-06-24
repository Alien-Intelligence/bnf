import type { User, Project } from "@/lib/generated/prisma/client"

export class FeedbackPolicy {
  constructor(private user: User) {}

  before(u: User): true | undefined {
    return u.role === "admin" ? true : undefined
  }

  // Anyone who can see the project (owner or a public project) may leave
  // feedback on its sessions, notes, and turns. Mirrors NotePolicy.list.
  submit(project: Project): boolean {
    return project.ownerId === this.user.id || project.isPublic
  }

  // Reading is scoped to the caller's OWN feedback (the query filters by
  // userId) — same visibility predicate as submit. Not a team-wide viewer.
  read(project: Project): boolean {
    return this.submit(project)
  }
}
