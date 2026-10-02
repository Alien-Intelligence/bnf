/**
 * GET /api/projects/:id/buffer
 *
 * The research buffer's comprehension view for the Constituer panel: total
 * candidate count, facets (type / language / source / period), and a bounded
 * candidate sample. Mirrors GET /corpus but over the pre-commit staging area.
 *
 * Query params: the shared `bufferFiltersSchema` (models/buffer/types.ts) —
 * type / kind / lang / source / title / creator / subject as CSV, yearFrom /
 * yearTo (overlap), undated ("true"/"1" or "false"/"0"), q — plus
 *   limit    — sample size, 1–200 (default: BUFFER_SAMPLE_SIZE)
 *
 * DELETE /api/projects/:id/buffer  { arks: string[] }
 *   Discard specific candidates from the buffer (per-candidate removal from the
 *   panel). Does not touch the corpus.
 *
 * Authorization: project member (read for GET, owner for DELETE) or admin.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseBody, parseQuery } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { z } from "zod"
import { BUFFER_SAMPLE_SIZE } from "@/lib/constants"
import { ProjectQueries } from "@/models/projects/queries"
import { BufferPolicy } from "@/models/buffer/policy"
import { BufferQueries } from "@/models/buffer/queries"
import { BufferService } from "@/models/buffer/service"
import { bufferDiscardSchema, bufferFiltersSchema, bufferFiltersToSet } from "@/models/buffer/types"
import type { BufferSnapshot } from "@/models/buffer/schema"

// The shared boundary schema, never a local copy: a second copy is how the
// "undated=false parsed as true" bug lived in this route.
const bufferQuerySchema = bufferFiltersSchema.extend({
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

type RouteCtx = { params: Promise<{ id: string }> }

export const GET = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = parseQuery(req, bufferQuerySchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(BufferPolicy).authorize("read", project)

  const { limit, ...filterParams } = parsed
  const filters = bufferFiltersToSet(filterParams)

  const snapshot = await BufferQueries.snapshot(
    projectId,
    filters,
    limit ?? BUFFER_SAMPLE_SIZE,
  )
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
  return ok<{ discarded: number }>({ discarded })
})
