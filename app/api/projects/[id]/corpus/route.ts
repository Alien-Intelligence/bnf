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
 *   yearFrom — decade start (inclusive), e.g. 1880
 *   yearTo   — decade end (inclusive), e.g. 1889
 *   undated  — when "true"/"1", filter to documents with year IS NULL
 *              (yearFrom/yearTo take precedence when both are present)
 *   q        — free-text search over title, author, excerpt (ILIKE, no pg_trgm)
 *
 *   Pagination:
 *   cursor   — opaque value from a previous response's `nextCursor`
 *   limit    — page size 1–100 (default: CORPUS_SAMPLE_SIZE = 25)
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
  // --- Filters (mirror corpusFiltersSchema in models/corpus/types.ts) ---
  /** Comma-separated doc-type codes */
  type: z.string().optional(),
  /** Comma-separated BCP-47 language codes */
  lang: z.string().optional(),
  /** Comma-separated source identifiers */
  source: z.string().optional(),
  /** Year range lower bound (inclusive) */
  yearFrom: z.coerce.number().int().optional(),
  /** Year range upper bound (inclusive) */
  yearTo: z.coerce.number().int().optional(),
  /** Filter to undated documents (year IS NULL). Ignored when yearFrom or yearTo is set. */
  undated: z.coerce.boolean().optional(),
  /** Free-text search on title / author / excerpt */
  q: z.string().trim().min(1).optional(),
  // --- Pagination ---
  /** Opaque cursor from a previous response's nextCursor field */
  cursor: z.string().optional(),
  /** Page size, 1–100. Defaults to CORPUS_SAMPLE_SIZE (25). */
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

/**
 * Split a CSV query-string value into a trimmed, non-empty string array.
 * Returns undefined when the value is absent or contains only whitespace.
 */
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
  const parsed = parseQuery(req, corpusQuerySchema)
  if (parsed instanceof Response) return parsed

  const project = await ProjectQueries.get(projectId)
  if (!project) return notFound("Projet introuvable")
  await bouncer.with(CorpusPolicy).authorize("read", project)

  const versionRef = parsed.version ?? "head"

  // Build the filters object only when at least one filter field is present.
  // Passing an empty object vs. undefined makes no difference in the query
  // layer, but being explicit keeps the call-site readable.
  const typeArr = splitCsv(parsed.type)
  const langArr = splitCsv(parsed.lang)
  const sourceArr = splitCsv(parsed.source)
  const hasFilters =
    typeArr !== undefined ||
    langArr !== undefined ||
    sourceArr !== undefined ||
    parsed.yearFrom !== undefined ||
    parsed.yearTo !== undefined ||
    parsed.undated !== undefined ||
    parsed.q !== undefined

  const filters = hasFilters
    ? {
        type: typeArr,
        lang: langArr,
        source: sourceArr,
        yearFrom: parsed.yearFrom,
        yearTo: parsed.yearTo,
        undated: parsed.undated,
        q: parsed.q,
      }
    : undefined

  const snapshot = await CorpusQueries.snapshot(
    projectId,
    typeof versionRef === "number" ? { seq: versionRef } : versionRef,
    { filters, cursor: parsed.cursor, limit: parsed.limit },
  )
  return ok<CorpusSnapshot>(snapshot)
})
