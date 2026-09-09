/**
 * GET /api/projects/:id/corpus/diff
 *
 * Returns the ARK-level diff between two corpus version sequences.
 *
 * Query params (both required):
 *   from — positive integer (seq of the base version)
 *   to   — positive integer (seq of the target version)
 *
 * Returns added[], removed[], addedCount, removedCount, fromSeq, toSeq.
 *
 * Authorization: read access on the project — see lib/authz/project-access.ts.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseQuery } from "@/app/api/_helpers"
import { ok, notFound, conflict } from "@/lib/api-response"
import { corpusDiffQuerySchema } from "@/models/corpus/types"
import { CorpusPolicy } from "@/models/corpus/policy"
import { CorpusQueries } from "@/models/corpus/queries"
import { ProjectQueries } from "@/models/projects/queries"
import { isDerived } from "@/lib/authz/corpus-source"
import type { CorpusDiff } from "@/models/corpus/schema"

type RouteCtx = { params: Promise<{ id: string }> }

export const GET = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = parseQuery(req, corpusDiffQuerySchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(CorpusPolicy).authorize("read", project)

  // A derived project has no version chain of its own: its local head is the
  // empty seq=1 placeholder, and the source's chain is not its history to
  // diff. Refusing is more honest than returning an always-empty diff.
  if (isDerived(project)) {
    return conflict(
      "Un espace de recherche dérivé n'a pas d'historique de corpus propre.",
    )
  }

  const diff = await CorpusQueries.diff(projectId, parsed.from, parsed.to)
  return ok<CorpusDiff>(diff)
})
