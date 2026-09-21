/**
 * GET  /api/projects/:id/shares — the grants on this project
 * POST /api/projects/:id/shares — grant or change a group's access
 *
 * Owner-only (ProjectPolicy.share), deliberately: a write-shared collaborator
 * may work inside a project but may never widen access to it. See
 * lib/authz/project-access.ts.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound, unprocessable } from "@/lib/api-response"
import { ProjectPolicy } from "@/models/projects/policy"
import { ProjectQueries } from "@/models/projects/queries"
import {
  GroupNotFoundError,
  ProjectSharingService,
} from "@/models/projects/service"
import type { ShareWithGroup } from "@/models/projects/schema"
import { shareProjectSchema } from "@/models/projects/types"

type RouteCtx = { params: Promise<{ id: string }> }

export const GET = withAuth(async (_req, _user, bouncer, ctx: RouteCtx) => {
  const { id } = await ctx.params

  const project = await ProjectQueries.get(id)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(ProjectPolicy).authorize("share", project)

  return ok<ShareWithGroup[]>(await ProjectSharingService.list(id))
})

export const POST = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id } = await ctx.params
  const parsed = await parseBody(req, shareProjectSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(id)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(ProjectPolicy).authorize("share", project)

  try {
    const shares = await ProjectSharingService.share(project, user.id, parsed)
    return ok<ShareWithGroup[]>(shares, 201)
  } catch (e) {
    if (e instanceof GroupNotFoundError) return unprocessable(e.message)
    throw e
  }
})
