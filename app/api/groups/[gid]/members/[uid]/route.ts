/**
 * DELETE /api/groups/:gid/members/:uid — remove a member (admin only)
 *
 * Removing a member revokes, immediately and everywhere, the access every
 * project shared into this group granted them: `groupIds` is resolved fresh on
 * each request, so their next call already sees the new membership.
 */
import { withAuth } from "@/app/api/_middleware"
import { ok, notFound } from "@/lib/api-response"
import { GroupPolicy } from "@/models/groups/policy"
import { GroupQueries } from "@/models/groups/queries"
import { GroupService } from "@/models/groups/service"
import type { GroupWithMembers } from "@/models/groups/schema"

type RouteCtx = { params: Promise<{ gid: string; uid: string }> }

export const DELETE = withAuth(async (_req, _user, bouncer, ctx: RouteCtx) => {
  const { gid, uid } = await ctx.params

  const group = await GroupQueries.get(gid)
  if (!group) return notFound("Groupe introuvable")
  await bouncer.with(GroupPolicy).authorize("manage")

  await GroupService.removeMember(gid, uid)

  const withMembers = await GroupQueries.withMembers(gid)
  if (!withMembers) return notFound("Groupe introuvable")

  return ok<GroupWithMembers>(withMembers)
})
