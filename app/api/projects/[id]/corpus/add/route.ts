/**
 * POST /api/projects/:id/corpus/add
 *
 * Adds ARKs to the project's corpus.
 *
 * Body (addToCorpusSchema):
 *   arks   — string[] (1–5000 BnF ARK identifiers)
 *   reason — string   (1–300 chars, recorded as the version note)
 *
 * Returns the new corpus snapshot with delta counters, plus `pending` (how many
 * added docs are still resolving in the background) and `nonIngestable` (ARKs
 * added but without digitized full text). The add is instant — ARKs are stubbed
 * synchronously and their BnF metadata is resolved out-of-band by the resolver.
 *
 * Authorization: project owner (mutate) or admin (before() bypass).
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { kickCanonicalize } from "@/lib/documents/canonicalizer"
import { kickResolve } from "@/lib/documents/resolver"
import { sourceFromArk } from "@/lib/mcp/vocab"
import { addToCorpusSchema } from "@/models/corpus/types"
import { CorpusPolicy } from "@/models/corpus/policy"
import { CorpusService, type CorpusAddResult } from "@/models/corpus/service"
import { ProjectQueries } from "@/models/projects/queries"

type RouteCtx = { params: Promise<{ id: string }> }

export const POST = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = await parseBody(req, addToCorpusSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(CorpusPolicy).authorize("mutate", project)

  // canonicalize: queue added catalogue notices (cb…) for background upgrade to
  // their digitized Gallica doc, so the corpus member becomes the consultable/
  // ingestable form — consistent with the agent add path. The add stays instant.
  const result = await CorpusService.addArks(project, user, parsed, undefined, {
    canonicalize: true,
  })
  // Resolve the new stubs' metadata in the background, after the response flushes.
  if (result.pending > 0) kickResolve(projectId)
  // Upgrade any added catalogue notices out-of-band too (no-op when none).
  if (parsed.arks.some((a) => sourceFromArk(a) === "catalogue")) {
    kickCanonicalize(projectId)
  }
  return ok<CorpusAddResult>(result)
})
