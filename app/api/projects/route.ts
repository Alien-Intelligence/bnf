/**
 * GET  /api/projects  — list the authenticated user's projects (with stats)
 * POST /api/projects  — create a project owned by the authenticated user
 *
 * Authorization: any authenticated user may list their own projects and
 * create new ones (ProjectPolicy.create). `ownerId` is taken from the session,
 * never from the request body.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok } from "@/lib/api-response"
import { ProjectPolicy } from "@/models/projects/policy"
import { ProjectQueries } from "@/models/projects/queries"
import { ProjectService } from "@/models/projects/service"
import { createProjectRequestSchema } from "@/models/projects/types"
import type { Project, ProjectListItem } from "@/models/projects/schema"

export const GET = withAuth(async (_req, user) => {
  const projects = await ProjectQueries.listForOwnerWithStats(user.id)
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
