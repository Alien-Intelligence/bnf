/**
 * POST /api/projects/:id/feedback
 *
 * Records a librarian's rating on a session, note, or turn within the project.
 *
 * Body (submitFeedbackSchema):
 *   target   — "session" | "note" | "turn"
 *   targetId — AppSession.id | Note.id | Message.id (uuid)
 *   rating   — "bad" | "ok" | "great"
 *   comment  — optional free text (≤ 2000 chars)
 *
 * One row per (user, target, targetId): re-submitting revises in place. The DB
 * is the source of truth — no Langfuse call happens at runtime; the row carries
 * `langfuseSessionId` for a future offline join.
 *
 * Authorization: project owner / public project (submit) or admin (before()).
 * A target that does not exist or belongs to another project → 404.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { submitFeedbackSchema } from "@/models/feedback/types"
import { FeedbackPolicy } from "@/models/feedback/policy"
import { FeedbackQueries } from "@/models/feedback/queries"
import { FeedbackService, FeedbackTargetNotFoundError } from "@/models/feedback/service"
import type { Feedback } from "@/models/feedback/schema"
import { ProjectQueries } from "@/models/projects/queries"

type RouteCtx = { params: Promise<{ id: string }> }

/**
 * GET /api/projects/:id/feedback
 *
 * The authenticated user's own feedback rows for this project — backs the
 * per-target "already rated / edit" UI state. Scoped to the caller (the query
 * filters by userId); this is NOT a team-wide feedback viewer.
 */
export const GET = withAuth(async (_req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(FeedbackPolicy).authorize("read", project)

  const rows = await FeedbackQueries.listForUserInProject(user.id, projectId)
  return ok<Feedback[]>(rows)
})

export const POST = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = await parseBody(req, submitFeedbackSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(FeedbackPolicy).authorize("submit", project)

  try {
    const row = await FeedbackService.submit({ project, user, input: parsed })
    return ok<Feedback>(row)
  } catch (e) {
    if (e instanceof FeedbackTargetNotFoundError) return notFound(e.message)
    throw e
  }
})
