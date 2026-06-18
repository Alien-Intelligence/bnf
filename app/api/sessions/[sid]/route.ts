/**
 * PUT    /api/sessions/:sid { title }  → rename session
 * DELETE /api/sessions/:sid            → archive session
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { ProjectQueries } from "@/models/projects/queries"
import { SessionPolicy } from "@/models/sessions/policy"
import { SessionQueries } from "@/models/sessions/queries"
import { SessionService } from "@/models/sessions/service"
import { updateSessionSchema } from "@/models/sessions/types"
import type { AppSession } from "@/models/sessions/schema"

type RouteCtx = { params: Promise<{ sid: string }> }

export const PUT = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { sid } = await ctx.params
  const parsed = await parseBody(req, updateSessionSchema)
  if (parsed instanceof Response) return parsed

  const session = await SessionQueries.get(sid)
  if (!session) return notFound("Session introuvable")

  const project = await ProjectQueries.get(session.projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(SessionPolicy).authorize("edit", { session, project })

  const updated = await SessionService.rename(sid, parsed.title)
  return ok<AppSession>(updated)
})

export const DELETE = withAuth(async (_req, _user, bouncer, ctx: RouteCtx) => {
  const { sid } = await ctx.params

  const session = await SessionQueries.get(sid)
  if (!session) return notFound("Session introuvable")

  const project = await ProjectQueries.get(session.projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(SessionPolicy).authorize("archive", { session, project })

  await SessionService.archive(sid)
  return ok<{ archived: true }>({ archived: true })
})
