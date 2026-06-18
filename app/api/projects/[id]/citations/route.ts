/**
 * GET /api/projects/:id/citations?ark=...
 *
 * Returns all citation usages for a given ARK within the project's notes.
 * Useful for the corpus panel to show "cited in N notes" with quick navigation.
 *
 * Query params:
 *   ark — required; the ARK identifier to look up (e.g. ark:/12148/bpt6k…)
 *
 * Authorization: project member (read).
 */
import { withAuth } from "@/app/api/_middleware"
import { parseQuery } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { ProjectQueries } from "@/models/projects/queries"
import { NotePolicy } from "@/models/notes/policy"
import { NoteQueries } from "@/models/notes/queries"
import { citationLookupSchema } from "@/models/notes/types"

type RouteCtx = { params: Promise<{ id: string }> }

export const GET = withAuth(async (req, _user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = parseQuery(req, citationLookupSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(NotePolicy).authorize("read", project)

  const usages = await NoteQueries.citationsForArk(projectId, parsed.ark)
  return ok(usages)
})
