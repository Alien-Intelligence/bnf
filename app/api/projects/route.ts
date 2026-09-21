/**
 * GET  /api/projects  — list every project the caller may see (with stats)
 * POST /api/projects  — create a project owned by the authenticated user
 *
 * GET returns owned projects, projects shared into one of the caller's groups,
 * and public ones; each row carries the access level the caller holds. The
 * visibility filter lives in ProjectQueries.listVisibleRowsForUser so it
 * cannot drift from lib/authz/project-access.ts.
 *
 * Authorization: any authenticated non-guest may create (ProjectPolicy.create).
 * `ownerId` is taken from the session, never from the request body.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok } from "@/lib/api-response"
import { ProjectPolicy } from "@/models/projects/policy"
import { listProjectsForUser } from "@/models/projects/service"
import { ProjectService } from "@/models/projects/service"
import { createProjectRequestSchema } from "@/models/projects/types"
import type { Project, ProjectListItem } from "@/models/projects/schema"

export const GET = withAuth(async (_req, user) => {
  const projects = await listProjectsForUser(user)
  return ok<ProjectListItem[]>(projects)
})

export const POST = withAuth(async (req, user, bouncer) => {
  const parsed = await parseBody(req, createProjectRequestSchema)
  if (parsed instanceof Response) return parsed

  await bouncer.with(ProjectPolicy).authorize("create")

  const project = await ProjectService.create({
    name: parsed.name,
    subtitle: parsed.subtitle,
    ownerId: user.id,
  })

  return ok<Project>(project, 201)
})
