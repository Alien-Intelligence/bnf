/**
 * GET /api/projects/:id/buffer
 *
 * The research buffer's comprehension view for the Constituer panel: total
 * candidate count, facets (type / language / source / period), and a bounded
 * candidate sample. Mirrors GET /corpus but over the pre-commit staging area.
 *
 * Query params (all optional; missing means "no filter"):
 *   type     — comma-separated doc-type codes
 *   lang     — comma-separated BCP-47 codes
 *   source   — comma-separated source identifiers
 *   yearFrom — decade start (inclusive)
 *   yearTo   — decade end (inclusive)
 *   undated  — "true"/"1" → candidates with year IS NULL
 *   q        — free-text over title + snippet
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
import { BufferQueries, type BufferFilterSet } from "@/models/buffer/queries"
import { BufferService } from "@/models/buffer/service"
import { bufferDiscardSchema } from "@/models/buffer/types"
import type { BufferSnapshot } from "@/models/buffer/schema"

const bufferQuerySchema = z.object({
  type: z.string().optional(),
  lang: z.string().optional(),
  source: z.string().optional(),
  yearFrom: z.coerce.number().int().optional(),
  yearTo: z.coerce.number().int().optional(),
  undated: z.coerce.boolean().optional(),
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

/** Split a CSV query value into a trimmed, non-empty array, or undefined. */
function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parts.length > 0 ? parts : undefined
}

type RouteCtx = { params: Promise<{ id: string }> }

export const GET = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = parseQuery(req, bufferQuerySchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(BufferPolicy).authorize("read", project)

  const filters: BufferFilterSet = {
    type: splitCsv(parsed.type),
    lang: splitCsv(parsed.lang),
    source: splitCsv(parsed.source),
    yearFrom: parsed.yearFrom,
    yearTo: parsed.yearTo,
    undated: parsed.undated,
    q: parsed.q,
  }

  const snapshot = await BufferQueries.snapshot(
    projectId,
    filters,
    parsed.limit ?? BUFFER_SAMPLE_SIZE,
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
