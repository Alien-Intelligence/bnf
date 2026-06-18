/**
 * GET /api/projects/:id/corpus
 *
 * Returns the corpus comprehension snapshot for the given project.
 *
 * Query params (all optional):
 *   version — "head" | "ingested" | <positive integer seq>
 *             Defaults to "head" when omitted.
 *
 * Authorization: project member (read) or admin (before() bypass).
 */
import { withAuth } from "@/app/api/_middleware"
import { parseQuery } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { z } from "zod"
import { ProjectQueries } from "@/models/projects/queries"
import { CorpusPolicy } from "@/models/corpus/policy"
import { CorpusQueries } from "@/models/corpus/queries"
import type { CorpusSnapshot } from "@/models/corpus/schema"

const corpusQuerySchema = z.object({
  version: z
    .union([
      z.literal("head"),
      z.literal("ingested"),
      z.coerce.number().int().positive(),
    ])
    .optional(),
})

type RouteCtx = { params: Promise<{ id: string }> }

export const GET = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = parseQuery(req, corpusQuerySchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(CorpusPolicy).authorize("read", project)

  const versionRef = parsed.version ?? "head"
  const snapshot = await CorpusQueries.snapshot(
    projectId,
    typeof versionRef === "number" ? { seq: versionRef } : versionRef,
  )
  return ok<CorpusSnapshot>(snapshot)
})
