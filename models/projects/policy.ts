import { isDerived } from "@/lib/authz/corpus-source"
import {
  canReadProject,
  canWriteProject,
  isProjectOwner,
} from "@/lib/authz/project-access"
import { USER_ROLE, type PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "./schema"

export class ProjectPolicy {
  constructor(private user: PolicyUser) {}

  /** Owner, admin, any group share, or a public project. */
  view(p: ProjectWithShares): boolean {
    return canReadProject(this.user, p)
  }

  /** Any authenticated non-guest user may create a project. */
  create(): boolean {
    return this.user.role !== USER_ROLE.GUEST
  }

  /**
   * See every project in the instance — the admin console's oversight table.
   *
   * Not project-scoped, so it carries its own explicit admin check rather than
   * delegating to the access table. Deliberately separate from `view`: an admin
   * may open any single project (rule 2), but listing them all is a different
   * question and belongs only to the console. See sharing.md.
   */
  listAll(): boolean {
    return this.user.role === USER_ROLE.ADMIN
  }

  edit(p: ProjectWithShares): boolean {
    return canWriteProject(this.user, p)
  }

  /**
   * Owner-only, deliberately. A `write`-shared collaborator may mutate the
   * corpus, run ingestion and write notes, but may not destroy the project.
   */
  delete(p: ProjectWithShares): boolean {
    return isProjectOwner(this.user, p)
  }

  /**
   * Owner-only, deliberately. Only the owner (or an admin, who resolves to
   * `owner`) may widen access to a project — a write share is a licence to
   * work inside it, not to re-grant it.
   *
   * And never a derived project, even for its owner. A derived workspace is
   * owned by the *reader*, but its corpus belongs to the source. Sharing it
   * would re-grant that corpus to a group the source's owner never granted
   * anything to — the reads route through `corpusProjectId()` and are gated on
   * the workspace's pinned share, not on the caller's access to the source. A
   * read-only grant must not be launderable into an onward one.
   *
   * This mirrors `CorpusPolicy`: a derived project has no corpus of its own to
   * give away, in access exactly as in mutation.
   */
  share(p: ProjectWithShares): boolean {
    return isProjectOwner(this.user, p) && !isDerived(p)
  }
}
