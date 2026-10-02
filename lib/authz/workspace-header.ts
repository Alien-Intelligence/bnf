// lib/authz/workspace-header.ts
//
// What the workspace header may show, decided ONCE on the server from the same
// predicates the routes and pages enforce:
//
// - the viewer half (every page): who is signed in, and whether the admin
//   console link appears — the same rule requireAdminUser gates the console
//   with (`mayOpenAdminConsole`);
// - the project half (inside a project): nothing at all unless the user may
//   read the project (canReadProject, the pages' own guard), then the steps
//   from workspaceStepsFor (what the step pages let this user open) and the
//   share button from ProjectPolicy.share (what POST /api/projects/:id/shares
//   accepts).
//
// The header therefore cannot offer a step that 404s, a Share button the route
// refuses, an admin link the console refuses, or a project's name on a 404.
//
// Pure: no DB, no `server-only`. Unit-tested in workspace-header.test.ts.

import { ProjectPolicy } from "@/models/projects/policy"
import { canReadProject } from "./project-access"
import { workspaceStepsFor } from "./workspace-steps"
import type { WorkspaceStep } from "@/lib/constants"
import { USER_ROLE, type PolicyUser, type User } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"

/** The admin console (app/[locale]/admin) is for admins only. */
export function mayOpenAdminConsole(user: Pick<User, "role">): boolean {
  return user.role === USER_ROLE.ADMIN
}

export type WorkspaceHeaderViewer = {
  name: string
  email: string
  /** Reveals the admin console link, on every page. */
  isAdmin: boolean
}

export function workspaceHeaderViewer(
  user: Pick<User, "name" | "email" | "role">,
): WorkspaceHeaderViewer {
  return { name: user.name, email: user.email, isAdmin: mayOpenAdminConsole(user) }
}

export type WorkspaceHeaderProject = {
  id: string
  name: string
  steps: readonly WorkspaceStep[]
  mayShare: boolean
}

/** The project half of the header, or null when the user may not read it. */
export function workspaceHeaderProject(
  user: PolicyUser,
  project: ProjectWithShares,
): WorkspaceHeaderProject | null {
  if (!canReadProject(user, project)) return null
  return {
    id: project.id,
    name: project.name,
    steps: workspaceStepsFor(user, project),
    mayShare: new ProjectPolicy(user).share(project),
  }
}
