/**
 * DELETE /api/projects/:id/shares/:gid — revoke a group's access
 *
 * Owner-only (ProjectPolicy.share). Any derived project created through this
 * grant survives — its sessions and notes are its own — but flips to the
 * revoked state, which the corpus and research surfaces render explicitly.
 */
import { withAuth } from "@/app/api/_middleware"
import { ok, notFound } from "@/lib/api-response"
import { ProjectPolicy } from "@/models/projects/policy"
import { ProjectQueries } from "@/models/projects/queries"
import {
  ProjectSharingService,
} from "@/models/projects/service"
import type { ShareWithGroup } from "@/models/projects/schema"

type RouteCtx = { params: Promise<{ id: string; gid: string }> }

export const DELETE = withAuth(async (_req, _user, bouncer, ctx: RouteCtx) => {
  const { id, gid } = await ctx.params

  const project = await ProjectQueries.get(id)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(ProjectPolicy).authorize("share", project)

  return ok<ShareWithGroup[]>(await ProjectSharingService.unshare(id, gid))
})
