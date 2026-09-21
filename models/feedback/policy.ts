import { canReadProject } from "@/lib/authz/project-access"
import type { PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"

export class FeedbackPolicy {
  constructor(private user: PolicyUser) {}

  // Anyone who can see the project may leave feedback on its sessions, notes
  // and turns — read access is the bar, not write: feedback is about the app,
  // not the corpus.
  submit(project: ProjectWithShares): boolean {
    return canReadProject(this.user, project)
  }

  // Reading is scoped to the caller's OWN feedback (the query filters by
  // userId) — same visibility predicate as submit. Not a team-wide viewer.
  read(project: ProjectWithShares): boolean {
    return this.submit(project)
  }
}
