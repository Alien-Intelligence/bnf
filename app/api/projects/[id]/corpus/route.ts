/**
 * GET /api/projects/:id/corpus
 *
 * Returns the corpus comprehension snapshot for the given project.
 *
 * Query params (all optional):
 *   version  — "head" | "ingested" | <positive integer seq>
 *              Defaults to "head" when omitted.
 *
 *   Filters (all optional; missing means "no filter"):
 *   type     — comma-separated doc-type codes, e.g. "book,press"
 *   lang     — comma-separated BCP-47 codes, e.g. "fr,la"
 *   source   — comma-separated source identifiers, e.g. "gallica,catalogue"
 *   session  — comma-separated AppSession ids; filters to docs those sessions added
 *   ingest   — comma-separated ingestion classes, e.g. "ocr,vision". The
 *              PRE-FLIGHT ingestability class — see classifyIngestion()
 *   yearFrom — decade start (inclusive), e.g. 1880
 *   yearTo   — decade end (inclusive), e.g. 1889
 *   undated  — when "true"/"1", filter to documents with year IS NULL
 *              (yearFrom/yearTo take precedence when both are present)
 *   outcome  — comma-separated indexation outcomes, e.g. "failed,not_ingested".
 *              What became of the document at ingestion, NOT whether it was
 *              ingestable — see classifyOutcome() in models/documents/schema.ts
 *   q        — free-text search over title, author, excerpt (ILIKE, no pg_trgm)
 *
 *   Pagination:
 *   cursor   — opaque value from a previous response's `nextCursor`
 *   limit    — page size 1–100 (default: CORPUS_SAMPLE_SIZE = 25)
 *
 * Authorization: read access on the project; admin resolves to owner — see
 * lib/authz/project-access.ts. There is no before() bypass.
 */
import { withAuth } from "@/app/api/_middleware"
import { parseQuery } from "@/app/api/_helpers"
import { ok, notFound } from "@/lib/api-response"
import { z } from "zod"
import { ProjectQueries } from "@/models/projects/queries"
import { resolveCorpusProject } from "@/app/api/_corpus-source"
import { CorpusPolicy } from "@/models/corpus/policy"
import { CorpusService } from "@/models/corpus/service"
import { parseCorpusFilters } from "@/app/api/_corpus-filters"
import type { CorpusSnapshot } from "@/models/corpus/schema"

// The route's own params — version selection and pagination. The filters go
// through the ONE corpus filter schema (models/corpus/types.ts), decoded from
// the query string by lib/corpus/filter-query.ts; the export route does the same.
const corpusQuerySchema = z.object({
  version: z
    .union([
      z.literal("head"),
      z.literal("ingested"),
      z.coerce.number().int().positive(),
    ])
    .optional(),
  /** Opaque cursor from a previous response's nextCursor field */
  cursor: z.string().optional(),
  /** Page size, 1–100. Defaults to CORPUS_SAMPLE_SIZE (25). */
  limit: z.coerce.number().int().min(1).max(100).optional(),
})


type RouteCtx = { params: Promise<{ id: string }> }


export const GET = withAuth(async (req, user, bouncer, ctx: RouteCtx) => {
  const { id: projectId } = await ctx.params
  const parsed = parseQuery(req, corpusQuerySchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(CorpusPolicy).authorize("read", project)

  // A derived project reads its source's corpus; a revoked grant is a 409, not
  // an empty snapshot. See app/api/_corpus-source.ts.
  const corpusId = resolveCorpusProject(project)
  if (corpusId instanceof Response) return corpusId

  const versionRef = parsed.version ?? "head"

  const filters = parseCorpusFilters(req, Object.keys(corpusQuerySchema.shape))
  if (filters instanceof Response) return filters

  const snapshot = await CorpusService.snapshot(
    corpusId,
    typeof versionRef === "number" ? { seq: versionRef } : versionRef,
    { filters, cursor: parsed.cursor, limit: parsed.limit },
  )
  return ok<CorpusSnapshot>(snapshot)
})
