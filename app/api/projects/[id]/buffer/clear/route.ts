/**
 * POST /api/projects/:id/buffer/clear
 *
 * Empty the research buffer (the panel's "Vider le tampon" action) — drops all
 * candidate + discarded rows for a fresh line of inquiry. Does NOT touch the
 * corpus (only the pre-commit staging area). No request body.
 *
 * Authorization: project owner (mutate) or admin.
 */
import { withAuth } from "@/app/api/_middleware"
import { ok, notFound } from "@/lib/api-response"
import { ProjectQueries } from "@/models/projects/queries"
import { BufferPolicy } from "@/models/buffer/policy"
import { BufferService } from "@/models/buffer/service"

type RouteCtx = { params: Promise<{ id: string }> }

export const POST = withAuth(async (_req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(BufferPolicy).authorize("mutate", project)

  const cleared = await BufferService.clear(projectId)
  return ok<{ cleared: number }>({ cleared })
})
