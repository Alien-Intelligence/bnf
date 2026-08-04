/**
 * POST /api/projects/:id/buffer/commit  { reason: string }
 *
 * Commit the buffer's candidates into the versioned corpus (the panel's
 * "Ajouter au corpus" action). Goes through BufferService.commit →
 * CorpusService.addArks, so advanceVersion() stays the sole version creator.
 * Kicks background metadata resolution + cb→Gallica canonicalization for the
 * newly-added stubs, exactly like POST /corpus/add.
 *
 * Authorization: project owner (mutate) or admin.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { kickCanonicalize } from "@/lib/documents/canonicalizer"
import { kickResolve } from "@/lib/documents/resolver"
import { ProjectQueries } from "@/models/projects/queries"
import { BufferPolicy } from "@/models/buffer/policy"
import { BufferService, type BufferCommitResult } from "@/models/buffer/service"
import { bufferCommitSchema } from "@/models/buffer/types"

type RouteCtx = { params: Promise<{ id: string }> }

export const POST = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = await parseBody(req, bufferCommitSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(BufferPolicy).authorize("mutate", project)

  const result = await BufferService.commit(project, user, { reason: parsed.reason })

  // Resolve the newly-added stubs + upgrade any catalogue notices in the
  // background (detached, individually timeout-bounded). kickCanonicalize is a
  // fast no-op when nothing is pending.
  if (result.corpus.pending > 0) kickResolve(projectId)
  kickCanonicalize(projectId)

  return ok<BufferCommitResult>(result)
})
