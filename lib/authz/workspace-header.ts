// lib/authz/workspace-header.ts
//
// The project half of the workspace header, decided ONCE on the server from
// the same predicates the routes enforce: the steps come from
// workspaceStepsFor (what the step pages let this user open), the share button
// from ProjectPolicy.share (what POST /api/projects/:id/shares will accept).
// The header therefore cannot offer a step that 404s or a Share button the
// route refuses — and the admin's missing admin link, which each page had to
// remember to pass, is no longer per-page knowledge at all.
//
// Pure: no DB, no `server-only`. Called by app/[locale]/projects/[projectId]/
// layout.tsx; unit-tested in workspace-header.test.ts.

import { ProjectPolicy } from "@/models/projects/policy"
import { workspaceStepsFor } from "./workspace-steps"
import type { WorkspaceStep } from "@/lib/constants"
import type { PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"

export type WorkspaceHeaderProject = {
  id: string
  name: string
  steps: readonly WorkspaceStep[]
  mayShare: boolean
}

export function workspaceHeaderProject(
  user: PolicyUser,
  project: ProjectWithShares,
): WorkspaceHeaderProject {
  return {
    id: project.id,
    name: project.name,
    steps: workspaceStepsFor(user, project),
    mayShare: new ProjectPolicy(user).share(project),
  }
}
