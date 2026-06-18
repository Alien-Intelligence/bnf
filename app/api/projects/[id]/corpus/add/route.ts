/**
 * POST /api/projects/:id/corpus/add
 *
 * Adds ARKs to the project's corpus.
 *
 * Body (addToCorpusSchema):
 *   arks   — string[] (1–5000 BnF ARK identifiers)
 *   reason — string   (1–300 chars, recorded as the version note)
 *
 * Returns the new corpus snapshot with delta counters.
 *
 * Authorization: project owner (mutate) or admin (before() bypass).
 *
 * Slice 1 note: every ARK in the request must already have a Document row.
 * If any ARK is missing its Document row, CorpusService.addArks() throws —
 * MCP resolve to create those rows is wired in slice 3.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { addToCorpusSchema } from "@/models/corpus/types"
import { CorpusPolicy } from "@/models/corpus/policy"
import { CorpusService, type CorpusMutationResult } from "@/models/corpus/service"
import { ProjectQueries } from "@/models/projects/queries"

type RouteCtx = { params: Promise<{ id: string }> }

export const POST = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = await parseBody(req, addToCorpusSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(CorpusPolicy).authorize("mutate", project)

  const result = await CorpusService.addArks(project, user, parsed)
  return ok<CorpusMutationResult>(result)
})
