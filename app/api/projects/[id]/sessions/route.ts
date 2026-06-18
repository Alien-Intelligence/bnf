/**
 * GET  /api/projects/:id/sessions?scope=corpus|research
 *   → list active sessions (Policy.list, SessionQueries.listForProject)
 *
 * POST /api/projects/:id/sessions { scope, title }
 *   → create a new session (Policy.create, SessionService.create)
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody, parseQuery } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { ProjectQueries } from "@/models/projects/queries"
import { SessionPolicy } from "@/models/sessions/policy"
import { SessionQueries } from "@/models/sessions/queries"
import { SessionService } from "@/models/sessions/service"
import { createSessionSchema, listSessionsQuerySchema } from "@/models/sessions/types"
import type { AppSession } from "@/models/sessions/schema"

type RouteCtx = { params: Promise<{ id: string }> }

export const GET = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = parseQuery(req, listSessionsQuerySchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(SessionPolicy).authorize("list", project)

  const sessions = await SessionQueries.listForProject(projectId, parsed.scope)
  return ok<AppSession[]>(sessions)
})

export const POST = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = await parseBody(req, createSessionSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(SessionPolicy).authorize("create", project)

  const session = await SessionService.create(projectId, parsed.scope, parsed.title)
  return ok<AppSession>(session, 201)
})
