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
 * Authorization: project member (read) or admin (before() bypass).
 */
import { withAuth } from "@/app/api/_middleware"
import { parseQuery } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { corpusDiffQuerySchema } from "@/models/corpus/types"
import { CorpusPolicy } from "@/models/corpus/policy"
import { CorpusQueries } from "@/models/corpus/queries"
import { ProjectQueries } from "@/models/projects/queries"
import type { CorpusDiff } from "@/models/corpus/schema"

type RouteCtx = { params: Promise<{ id: string }> }

export const GET = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = parseQuery(req, corpusDiffQuerySchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(CorpusPolicy).authorize("read", project)

  const diff = await CorpusQueries.diff(projectId, parsed.from, parsed.to)
  return ok<CorpusDiff>(diff)
})
