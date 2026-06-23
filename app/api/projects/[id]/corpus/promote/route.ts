/**
 * POST /api/projects/:id/corpus/promote
 *
 * Promotes a catalogue notice (`cb…`) to its digitized Gallica document on
 * demand — the manual counterpart to the add-time cb→Gallica canonicalization,
 * surfaced in the detail panel when the add-time pass failed transiently.
 *
 * Body (promoteNoticeSchema):
 *   ark — a single BnF ARK identifier (must be a `cb…` notice)
 *
 * On success (status "upgraded") the notice is swapped for its digitized doc in
 * a new corpus version and that doc's metadata resolves in the background. When
 * the notice has no digitization ("not_digitized") or the BnF API is still flaky
 * ("api_error"), nothing is mutated and the outcome is recorded for the UI.
 *
 * Authorization: project owner (mutate) or admin (before() bypass).
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { kickResolve } from "@/lib/documents/resolver"
import { promoteNoticeSchema } from "@/models/corpus/types"
import { CorpusPolicy } from "@/models/corpus/policy"
import { CorpusService, type CorpusPromoteResult } from "@/models/corpus/service"
import { ProjectQueries } from "@/models/projects/queries"

type RouteCtx = { params: Promise<{ id: string }> }

export const POST = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = await parseBody(req, promoteNoticeSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(CorpusPolicy).authorize("mutate", project)

  const result = await CorpusService.promoteNotice(project, user, parsed.ark)
  // Resolve the newly-added digitized doc's metadata in the background.
  if (result.promoted && result.pendingResolve) kickResolve(projectId)
  return ok<CorpusPromoteResult>(result)
})
