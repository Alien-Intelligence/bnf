/**
 * PATCH  /api/groups/:gid — rename a group
 * DELETE /api/groups/:gid — delete a group
 *
 * Both admin-only. Deleting cascades to group_member and project_share: every
 * project shared into the group loses that grant, and any derived project
 * created through it flips to the revoked state (corpus_source_share_id is set
 * null) rather than disappearing.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound, conflict, unprocessable } from "@/lib/api-response"
import { GroupPolicy } from "@/models/groups/policy"
import { GroupQueries } from "@/models/groups/queries"
import { GroupService } from "@/models/groups/service"
import { renameGroupSchema } from "@/models/groups/types"
import {
  GroupSlugTakenError,
  InvalidGroupNameError,
  type Group,
} from "@/models/groups/schema"

type RouteCtx = { params: Promise<{ gid: string }> }

export const PATCH = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { gid } = await ctx.params
  const parsed = await parseBody(req, renameGroupSchema)
  if (parsed instanceof Response) return parsed

  const group = await GroupQueries.get(gid)
  if (!group) return notFound("Groupe introuvable")
  await bouncer.with(GroupPolicy).authorize("manage")

  try {
    return ok<Group>(await GroupService.rename(gid, parsed.name))
  } catch (e) {
    if (e instanceof GroupSlugTakenError) return conflict(e.message)
    if (e instanceof InvalidGroupNameError) return unprocessable(e.message)
    throw e
  }
})

export const DELETE = withAuth(async (_req, _user, bouncer, ctx: RouteCtx) => {
  const { gid } = await ctx.params

  const group = await GroupQueries.get(gid)
  if (!group) return notFound("Groupe introuvable")
  await bouncer.with(GroupPolicy).authorize("manage")

  await GroupService.delete(gid)
  return ok<{ deleted: true }>({ deleted: true })
})
