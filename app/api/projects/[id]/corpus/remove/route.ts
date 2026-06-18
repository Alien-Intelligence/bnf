/**
 * POST /api/projects/:id/corpus/remove
 *
 * Removes ARKs from the project's corpus.
 *
 * Body (removeFromCorpusSchema):
 *   arks   — string[] (1–5000 BnF ARK identifiers)
 *   reason — string   (1–300 chars, recorded as the version note)
 *
 * Returns the new corpus snapshot with delta counters.
 * ARKs not currently in the corpus are silently skipped (no-op).
 *
 * Authorization: project owner (mutate) or admin (before() bypass).
 *
 * Removing an ARK does NOT delete its Document row — membership change only
 * (corpus-versioning.md invariant: "Document rows live forever").
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { removeFromCorpusSchema } from "@/models/corpus/types"
import { CorpusPolicy } from "@/models/corpus/policy"
import { CorpusService, type CorpusMutationResult } from "@/models/corpus/service"
import { ProjectQueries } from "@/models/projects/queries"

type RouteCtx = { params: Promise<{ id: string }> }

export const POST = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = await parseBody(req, removeFromCorpusSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(CorpusPolicy).authorize("mutate", project)

  const result = await CorpusService.removeArks(project, user, parsed)
  return ok<CorpusMutationResult>(result)
})
