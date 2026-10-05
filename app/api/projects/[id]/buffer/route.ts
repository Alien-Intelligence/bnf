/**
 * GET /api/projects/:id/buffer
 *
 * The research buffer's comprehension view for the Constituer panel: total
 * candidate count, facets (type / language / source / period), and a bounded
 * candidate sample. Mirrors GET /corpus but over the pre-commit staging area.
 *
 * Query params: the buffer filters, decoded by `bufferFilterInputFromParams`
 * and validated by `bufferFilterSetSchema` — the SAME schema the agent tools
 * use (models/buffer/types.ts): type / kind / lang / source / title / creator /
 * subject as CSV, yearFrom / yearTo (overlap), undated / unresolved
 * ("true"/"1" or "false"/"0"), q, and the exclusion as `not.<field>` — plus
 *   limit    — sample size, 1–BUFFER_LIST_MAX_LIMIT (default: BUFFER_SAMPLE_SIZE)
 *
 * DELETE /api/projects/:id/buffer  { arks: string[] }
 *   Discard specific candidates from the buffer (per-candidate removal from the
 *   panel). Does not touch the corpus.
 *
 * Authorization: project member (read for GET, owner for DELETE) or admin.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody, parseQuery } from "@/app/api/_helpers"
import { ok, notFound, badRequest } from "@/lib/api-response"
import { z } from "zod"
import { BUFFER_LIST_MAX_LIMIT, BUFFER_SAMPLE_SIZE } from "@/lib/constants"
import { ProjectQueries } from "@/models/projects/queries"
import { BufferPolicy } from "@/models/buffer/policy"
import { BufferService } from "@/models/buffer/service"
import { bufferFilterInputFromParams } from "@/lib/buffer/filter-query"
import { bufferDiscardSchema, bufferFilterSetSchema } from "@/models/buffer/types"
import type { BufferDiscardResult, BufferSnapshot } from "@/models/buffer/schema"

/** The route's own parameter; the filters go through the shared schema. */
const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(BUFFER_LIST_MAX_LIMIT).optional(),
})

type RouteCtx = { params: Promise<{ id: string }> }

export const GET = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const page = parseQuery(req, pageQuerySchema)
  if (page instanceof Response) return page
  // The shared filter schema, never a local copy: a second copy is how the
  // "undated=false parsed as true" bug lived in this route.
  const filters = bufferFilterSetSchema.safeParse(bufferFilterInputFromParams(new URL(req.url).searchParams))
  if (!filters.success) return badRequest("Invalid buffer filters", filters.error.issues)

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(BufferPolicy).authorize("read", project)

  const snapshot = await BufferService.snapshot(projectId, filters.data, page.limit ?? BUFFER_SAMPLE_SIZE)
  return ok<BufferSnapshot>(snapshot)
})

export const DELETE = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = await parseBody(req, bufferDiscardSchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(BufferPolicy).authorize("mutate", project)

  const discarded = await BufferService.discard(projectId, parsed.arks)
  return ok<BufferDiscardResult>({ discarded })
})
