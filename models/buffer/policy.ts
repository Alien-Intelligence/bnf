import { canReadProject, canWriteProject } from "@/lib/authz/project-access"
import { isDerived } from "@/lib/authz/corpus-source"
import type { PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"

/**
 * Authorization for the research buffer. The buffer is pre-commit scratch
 * scoped to a project: reading follows the project's visibility, but every
 * mutation (add / discard / remove / commit / clear) needs write access —
 * committing advances the corpus, so it must never be triggerable by someone
 * who only holds a read share or is viewing a public project.
 */
export class BufferPolicy {
  constructor(private user: PolicyUser) {}

  read(project: ProjectWithShares): boolean {
    return canReadProject(this.user, project)
  }

  /** Write access, and only on a project that owns its corpus. */
  mutate(project: ProjectWithShares): boolean {
    return canWriteProject(this.user, project) && !isDerived(project)
  }
}
