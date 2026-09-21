// lib/authz/project-access.ts
//
// The single source of truth for "what can this user do with this project?".
//
// Every policy method, every server page guard and every route handler that
// gates on project access delegates here. Nothing else may re-derive the
// answer — see CLAUDE.md, "Groups & sharing".
//
// Pure functions: no DB, no `server-only`. Both server components and
// models/*/policy.ts import from here, and the truth table is unit-tested
// exhaustively in project-access.test.ts.

import { USER_ROLE } from "@/models/users/schema"
import type { PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"

/** The access a ProjectShare grants. Stored as a plain String column. */
export const PROJECT_ACCESS = {
  READ: "read",
  WRITE: "write",
} as const

export type ProjectAccess = (typeof PROJECT_ACCESS)[keyof typeof PROJECT_ACCESS]

export function isProjectAccess(value: string): value is ProjectAccess {
  return value === PROJECT_ACCESS.READ || value === PROJECT_ACCESS.WRITE
}

/**
 * The resolved level a user holds on a project. `owner` is strictly stronger
 * than `write`: only an owner (or an admin, who resolves to `owner`) may
 * delete a project or widen its access by sharing it.
 */
export const PROJECT_ACCESS_LEVEL = {
  OWNER: "owner",
  WRITE: "write",
  READ: "read",
  NONE: "none",
} as const

export type ProjectAccessLevel =
  (typeof PROJECT_ACCESS_LEVEL)[keyof typeof PROJECT_ACCESS_LEVEL]

/**
 * Resolution order — first match wins:
 *
 *   1. the user owns the project              → owner
 *   2. the user is an app admin               → owner
 *   3. a `write` share on one of their groups → write
 *   4. a `read` share on one of their groups  → read
 *   5. the project is public                  → read
 *   6. otherwise                              → none
 *
 * Rule 3 is checked before rule 4 so a user in two groups — one shared at
 * `read`, one at `write` — gets the stronger of the two.
 */
export function projectAccessLevel(
  user: PolicyUser,
  project: ProjectWithShares,
): ProjectAccessLevel {
  if (project.ownerId === user.id) return PROJECT_ACCESS_LEVEL.OWNER
  if (user.role === USER_ROLE.ADMIN) return PROJECT_ACCESS_LEVEL.OWNER

  const groupIds = new Set(user.groupIds)
  const mine = project.shares.filter((s) => groupIds.has(s.groupId))

  if (mine.some((s) => s.access === PROJECT_ACCESS.WRITE)) {
    return PROJECT_ACCESS_LEVEL.WRITE
  }
  if (mine.some((s) => s.access === PROJECT_ACCESS.READ)) {
    return PROJECT_ACCESS_LEVEL.READ
  }

  if (project.isPublic) return PROJECT_ACCESS_LEVEL.READ

  return PROJECT_ACCESS_LEVEL.NONE
}

/** Any level above `none` can read. */
export function canReadProject(
  user: PolicyUser,
  project: ProjectWithShares,
): boolean {
  return projectAccessLevel(user, project) !== PROJECT_ACCESS_LEVEL.NONE
}

/** Only `owner` and `write` can mutate. */
export function canWriteProject(
  user: PolicyUser,
  project: ProjectWithShares,
): boolean {
  const level = projectAccessLevel(user, project)
  return (
    level === PROJECT_ACCESS_LEVEL.OWNER || level === PROJECT_ACCESS_LEVEL.WRITE
  )
}

/**
 * Owner-only actions: delete, and re-sharing. A `write`-shared collaborator
 * may work inside the project but may never widen access to it or destroy it.
 */
export function isProjectOwner(
  user: PolicyUser,
  project: ProjectWithShares,
): boolean {
  return projectAccessLevel(user, project) === PROJECT_ACCESS_LEVEL.OWNER
}

/**
 * The listing counterpart of the access table.
 *
 * `projectAccessLevel` answers "may this user reach THIS project", one row at a
 * time. A list has to answer it for rows it has not loaded yet, so the same
 * decision has to be expressible as a filter — and that filter must be derived
 * HERE, not hand-written into a `where` clause somewhere else.
 *
 * Queries take this value and apply it. They never see the user, so they cannot
 * re-derive the answer — which is the whole point.
 */
export type VisibilityScope =
  | { unrestricted: true }
  | { unrestricted: false; userId: string; groupIds: string[] }

/**
 * What belongs to a user personally: projects they own, projects shared into one
 * of their groups, and public ones — rules 1, 4 and 5 of the access table.
 *
 * **Deliberately not widened for an admin**, and this is the one place in the
 * codebase where the admin bypass does not apply. Admin is rule 2 of the access
 * table because an admin may *open* any project; it does not follow that every
 * project belongs on their home screen. 0.17.0 conflated the two and listed
 * every researcher's private workspace under « Partagés avec moi » — a heading
 * asserting a share that never happened. Org-wide oversight is a different
 * question, asked in the admin console (`adminVisibilityScope`).
 */
export function personalVisibilityScope(user: PolicyUser): VisibilityScope {
  return { unrestricted: false, userId: user.id, groupIds: user.groupIds }
}

/**
 * Everything an admin may administer — unrestricted for them, and identical to
 * `personalVisibilityScope` for everyone else, so a non-admin reaching an admin
 * listing still sees only their own rows rather than the whole table.
 *
 * For the admin console only. A user-facing list wants the personal scope.
 */
export function adminVisibilityScope(user: PolicyUser): VisibilityScope {
  if (user.role === USER_ROLE.ADMIN) return { unrestricted: true }
  return personalVisibilityScope(user)
}
