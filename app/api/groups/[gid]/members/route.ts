/**
 * GET  /api/groups/:gid/members — the group's roster
 * POST /api/groups/:gid/members — add a member by email (admin only)
 *
 * Reading the roster is open to the group's own members (GroupPolicy.view);
 * changing it is admin-only.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound, unprocessable } from "@/lib/api-response"
import { GroupPolicy } from "@/models/groups/policy"
import { GroupQueries } from "@/models/groups/queries"
import { GroupService } from "@/models/groups/service"
import { addMemberSchema } from "@/models/groups/types"
import {
  type GroupWithMembers,
} from "@/models/groups/schema"
import {
  UserNotFoundError,
} from "@/models/groups/service"

type RouteCtx = { params: Promise<{ gid: string }> }

export const GET = withAuth(async (_req, _user, bouncer, ctx: RouteCtx) => {
  const { gid } = await ctx.params

  const group = await GroupQueries.get(gid)
  if (!group) return notFound("Groupe introuvable")
  await bouncer.with(GroupPolicy).authorize("view", group)

  const withMembers = await GroupQueries.withMembers(gid)
  if (!withMembers) return notFound("Groupe introuvable")

  return ok<GroupWithMembers>(withMembers)
})

export const POST = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { gid } = await ctx.params
  const parsed = await parseBody(req, addMemberSchema)
  if (parsed instanceof Response) return parsed

  const group = await GroupQueries.get(gid)
  if (!group) return notFound("Groupe introuvable")
  await bouncer.with(GroupPolicy).authorize("manage")

  try {
    await GroupService.addMemberByEmail(gid, parsed.email)
  } catch (e) {
    // An address matching no account is the admin's mistake, not a server
    // error — say so, rather than reporting a success that added nobody.
    if (e instanceof UserNotFoundError) return unprocessable(e.message)
    throw e
  }

  const withMembers = await GroupQueries.withMembers(gid)
  if (!withMembers) return notFound("Groupe introuvable")

  return ok<GroupWithMembers>(withMembers, 201)
})
