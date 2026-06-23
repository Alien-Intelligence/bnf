/**
 * POST /api/projects/:id/corpus/retry
 *
 * Re-queues background metadata resolution for one or more documents whose
 * resolution previously failed (or stalled). Flips them back to `pending`,
 * resets the attempt counter, and kicks the resolver — the detail panel's
 * "retry" button and its auto-retry on first paint both call this.
 *
 * Body (retryResolveSchema):
 *   arks — string[] (1–50 BnF ARK identifiers)
 *
 * Returns `{ retried }` — how many rows were actually re-queued (a row that is
 * already resolved is left alone). Resolution then runs out-of-band.
 *
 * Authorization: project owner (mutate) or admin (before() bypass).
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { kickResolve } from "@/lib/documents/resolver"
import { retryResolveSchema } from "@/models/corpus/types"
import { CorpusPolicy } from "@/models/corpus/policy"
import { DocumentService } from "@/models/documents/service"
import { ProjectQueries } from "@/models/projects/queries"

type RouteCtx = { params: Promise<{ id: string }> }

export const POST = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = await parseBody(req, retryResolveSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(CorpusPolicy).authorize("mutate", project)

  const result = await DocumentService.retryResolution(projectId, parsed.arks)
  // Drain the freshly re-queued stubs in the background, after the response flushes.
  if (result.retried > 0) kickResolve(projectId)
  return ok(result)
})
