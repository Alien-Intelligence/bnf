/**
 * GET  /api/groups — list groups
 * POST /api/groups — create a group (admin only)
 *
 * GET returns every group for an admin, and only the caller's own groups
 * otherwise: a project owner needs the list to know what they can share into,
 * but must not learn the full org chart.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, conflict, unprocessable } from "@/lib/api-response"
import { GroupPolicy } from "@/models/groups/policy"
import { GroupQueries } from "@/models/groups/queries"
import { visibilityScopeFor } from "@/lib/authz/project-access"
import { GroupService } from "@/models/groups/service"
import { createGroupSchema } from "@/models/groups/types"
import {
  type Group,
  type GroupListItem,
} from "@/models/groups/schema"
import {
  GroupSlugTakenError,
  InvalidGroupNameError,
} from "@/models/groups/service"

export const GET = withAuth(async (_req, user, bouncer) => {
  await bouncer.with(GroupPolicy).authorize("list")
  return ok<GroupListItem[]>(
    await GroupQueries.listVisible(visibilityScopeFor(user)),
  )
})

export const POST = withAuth(async (req, _user, bouncer) => {
  const parsed = await parseBody(req, createGroupSchema)
  if (parsed instanceof Response) return parsed

  await bouncer.with(GroupPolicy).authorize("manage")

  try {
    const group = await GroupService.create(parsed.name)
    return ok<Group>(group, 201)
  } catch (e) {
    if (e instanceof GroupSlugTakenError) return conflict(e.message)
    if (e instanceof InvalidGroupNameError) return unprocessable(e.message)
    throw e
  }
})
