import type { User, Project } from "@/lib/generated/prisma/client"

/**
 * Authorization for the research buffer. The buffer is pre-commit scratch scoped
 * to a project: reading follows the project's visibility, but every mutation
 * (add / discard / remove / commit / clear) is owner-only — committing advances
 * the corpus, so it must never be triggerable by a non-owner viewing a public
 * project.
 */
export class BufferPolicy {
  constructor(private user: User) {}

  before(u: User): true | undefined {
    return u.role === "admin" ? true : undefined
  }

  read(project: Project): boolean {
    return project.ownerId === this.user.id || project.isPublic
  }

  mutate(project: Project): boolean {
    return project.ownerId === this.user.id
  }
}
