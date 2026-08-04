/**
 * Research-buffer ("tampon") tool definitions for the BnF corpus agent.
 *
 * The buffer is a persisted, project-scoped staging area for ARK candidates.
 * `corpus_search` (below) funnels BnF search into it so results are durable +
 * visible instead of living in the agent's thinking block; the `buffer_*` tools
 * curate the candidate set (list, facet, filter-remove, discard, manual add)
 * and finally `buffer_commit` moves it into the versioned corpus via
 * CorpusService.addArks — the sole version-advancing path.
 *
 * Every mutating tool publishes a `buffer_event` via `ctx.emit` so the buffer
 * panel live-updates; `buffer_commit` also publishes a `corpus_event` because it
 * advances the corpus. ProjectId is resolved lazily from the session row (same
 * discipline as corpus.ts) to stay parallel-safe.
 */
import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import {
  BUFFER_SAMPLE_SIZE,
  BUFFER_SEARCH_MAX_PAGE_SIZE,
  BUFFER_SEARCH_PAGE_SIZE,
  CORPUS_REASON_MAX_LEN,
} from "@/lib/constants"
import { prisma } from "@/lib/db"
import { kickCanonicalize } from "@/lib/documents/canonicalizer"
import { kickResolve } from "@/lib/documents/resolver"
import { requireMcpEnv } from "@/lib/env"
import { callBnfTool } from "@/lib/mcp/call"
import { BnfMcpError } from "@/lib/mcp/errors"
import { parseBnfDate } from "@/lib/mcp/normalize"
import { sourceFromArk } from "@/lib/mcp/vocab"
import { BufferQueries, type BufferFilterSet } from "@/models/buffer/queries"
import { BufferService } from "@/models/buffer/service"
import { arkSchema, type BufferCandidateInput } from "@/models/buffer/types"
import type { TurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS } from "./constants"

// ---------------------------------------------------------------------------
// Shared agent-facing filter schema (array-based, like corpus.ts). Distinct
// from the CSV `bufferFiltersSchema` in models/buffer/types.ts, which is the
// REST/UI query-string form.
// ---------------------------------------------------------------------------

const bufferFilterSchema = z
  .object({
    type: z
      .array(z.string())
      .optional()
      .describe('Doc-type codes to match, e.g. ["press","book"].'),
    lang: z
      .array(z.string())
      .optional()
      .describe('BCP-47 language codes to match, e.g. ["fr","la"].'),
    source: z
      .array(z.string())
      .optional()
      .describe('Sources to match: "gallica" | "catalogue" | "other".'),
    yearFrom: z.number().int().optional().describe("Year lower bound, inclusive."),
    yearTo: z.number().int().optional().describe("Year upper bound, inclusive."),
    undated: z
      .boolean()
      .optional()
      .describe("Match candidates with no date. Ignored when yearFrom/yearTo is set."),
    q: z.string().trim().min(1).optional().describe("Free-text match over title + snippet."),
  })
  .describe("Metadata filters over the buffer candidates. Omit a field to leave it unconstrained.")

const facetDimensionEnum = z.enum(["period", "type", "lang", "source"])

/** Resolve the projectId for an appSession (single PK read; no circular import). */
async function projectIdFromSession(appSessionId: string): Promise<string> {
  const session = await prisma.appSession.findUniqueOrThrow({
    where: { id: appSessionId },
    select: { projectId: true },
  })
  return session.projectId
}

/** Publish a buffer_event carrying the post-op candidate total. */
async function emitBuffer(
  ctx: TurnScopedCtx,
  projectId: string,
  kind: "added" | "removed" | "committed" | "cleared",
  count: number,
): Promise<number> {
  const total = await BufferQueries.count(projectId)
  ctx.emit?.({ type: "buffer_event", data: { kind, count, total } })
  return total
}

// ---------------------------------------------------------------------------
// buffer_list
// ---------------------------------------------------------------------------

export const bufferListTool = defineTool<
  z.ZodObject<{
    filters: z.ZodOptional<typeof bufferFilterSchema>
    limit: z.ZodOptional<z.ZodNumber>
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.bufferList,
  description:
    "List the candidate documents currently in the research buffer (the pre-commit " +
    "staging area), most recent first, with their metadata (ark, title, year, type). " +
    "Pass `filters` to scope the list to a subset. Returns `total` (candidates " +
    "matching the filters) and one page of `candidates`. Use this to show the " +
    "librarian what has been gathered before committing to the corpus. To ENUMERATE " +
    "a large buffer, raise `limit`; to CHARACTERISE it (counts by type/period), " +
    "prefer buffer_stats.",
  inputSchema: z.object({
    filters: bufferFilterSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(`Page size (1–200, default ${BUFFER_SAMPLE_SIZE}).`),
  }),
  handler: async (input, ctx) => {
    const projectId = await projectIdFromSession(ctx.appSessionId)
    const { total, rows } = await BufferQueries.list(
      projectId,
      input.filters as BufferFilterSet | undefined,
      input.limit ?? BUFFER_SAMPLE_SIZE,
    )
    return { total, candidates: rows }
  },
})

// ---------------------------------------------------------------------------
// buffer_stats
// ---------------------------------------------------------------------------

export const bufferStatsTool = defineTool<
  z.ZodObject<{
    filters: z.ZodOptional<typeof bufferFilterSchema>
    cross_facets: z.ZodOptional<z.ZodArray<typeof facetDimensionEnum>>
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.bufferStats,
  description:
    "Return facet counts (type, language, source, period) and the total candidate " +
    "count for the research buffer — no document sample. The fastest way to " +
    "characterise what has been gathered (\"312 candidats : 280 presse, surtout " +
    "1880s–1890s\") before curating. Pass `filters` to scope every count. Pass " +
    "`cross_facets` (a pair of dimensions, e.g. [\"period\",\"type\"]) to ALSO get a " +
    "crossed breakdown — the count for each combination, ideal for locating a " +
    "sub-population to keep or drop.",
  inputSchema: z.object({
    filters: bufferFilterSchema.optional(),
    // A fixed-length ARRAY, not a z.tuple: a tuple serialises to the positional
    // `items: [A, B]` JSON-schema form Google's function-declaration schema
    // rejects, crashing Gemini turns via OpenRouter. See corpus_stats.
    cross_facets: z
      .array(facetDimensionEnum)
      .length(2)
      .optional()
      .describe('Two dimensions to cross-tabulate, e.g. ["period","type"].'),
  }),
  handler: async (input, ctx) => {
    const projectId = await projectIdFromSession(ctx.appSessionId)
    const filters = input.filters as BufferFilterSet | undefined
    const snapshot = await BufferQueries.snapshot(projectId, filters, 0)
    const stats = { total: snapshot.total, facets: snapshot.facets }

    if (!input.cross_facets) return stats

    const cross = await BufferQueries.crossFacets(
      projectId,
      [input.cross_facets[0], input.cross_facets[1]],
      filters,
    )
    return { ...stats, cross }
  },
})

// ---------------------------------------------------------------------------
// buffer_remove_by_filter
// ---------------------------------------------------------------------------

export const bufferRemoveByFilterTool = defineTool<
  z.ZodObject<{
    filters: typeof bufferFilterSchema
    dry_run: z.ZodOptional<z.ZodBoolean>
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.bufferRemoveByFilter,
  description:
    "Remove EVERY candidate matching a metadata filter from the buffer — the way " +
    "to prune a sub-population before committing (e.g. drop everything outside the " +
    "wanted period: `{\"filters\":{\"lang\":[\"en\"]}}`). Same semantics as " +
    "corpus_remove_by_filter: it removes what MATCHES the filter. ALWAYS preview " +
    "first with dry_run=true (the default) — it returns `matched` (how many would " +
    "be removed) and a sample of their ARKs WITHOUT changing anything; show the " +
    "librarian that count, then call again with dry_run=false to commit the " +
    "removal. An empty filter is refused (status \"empty_filter\") — it would drop " +
    "the whole buffer; use buffer_clear for that, explicitly. Removed candidates " +
    "are discarded from the buffer, NOT the corpus (the buffer is pre-commit).",
  inputSchema: z.object({
    filters: bufferFilterSchema,
    dry_run: z
      .boolean()
      .optional()
      .describe(
        "When true (default), preview only — report what would be removed without mutating. Set false to commit.",
      ),
  }),
  handler: async (input, ctx) => {
    const projectId = await projectIdFromSession(ctx.appSessionId)
    const dryRun = input.dry_run ?? true

    const result = await BufferService.removeByFilter(projectId, {
      filters: input.filters as BufferFilterSet,
      dryRun,
    })

    if (result.status === "removed" && result.removed > 0) {
      await emitBuffer(ctx, projectId, "removed", result.removed)
    }

    return result
  },
})

// ---------------------------------------------------------------------------
// buffer_add
// ---------------------------------------------------------------------------

export const bufferAddTool = defineTool<
  z.ZodObject<{ arks: z.ZodArray<typeof arkSchema> }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.bufferAdd,
  description:
    "Manually add one or more ARKs to the research buffer as candidates (without a " +
    "search). Use this only when the librarian gives you specific ARKs to stage; " +
    "the normal way candidates enter the buffer is corpus_search. Deduplicated by " +
    "ARK. Metadata is left empty (no background resolution — the buffer is " +
    "pre-commit scratch); it fills in only if a later corpus_search surfaces the " +
    "same ARK. Returns `added` (new candidates) and `total` (buffer size).",
  inputSchema: z.object({
    arks: z
      .array(arkSchema)
      .min(1)
      .max(5_000)
      .describe('BnF ARK identifiers to stage, e.g. ["ark:/12148/bpt6k2839841"].'),
  }),
  handler: async (input, ctx) => {
    const projectId = await projectIdFromSession(ctx.appSessionId)
    const result = await BufferService.registerCandidates({
      projectId,
      sessionId: ctx.appSessionId,
      originTool: AGENT_TOOLS.bufferAdd,
      candidates: input.arks.map((ark) => ({ ark })),
    })
    const total = await emitBuffer(ctx, projectId, "added", result.added)
    return { requested: result.requested, added: result.added, total }
  },
})

// ---------------------------------------------------------------------------
// buffer_discard
// ---------------------------------------------------------------------------

export const bufferDiscardTool = defineTool<
  z.ZodObject<{ arks: z.ZodArray<typeof arkSchema> }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.bufferDiscard,
  description:
    "Drop specific candidates from the buffer by ARK (when the librarian names ones " +
    "to exclude). For dropping a whole sub-population by criterion, prefer " +
    "buffer_remove_by_filter. Discarded candidates leave the buffer but are NOT " +
    "removed from the corpus (they were never committed). Returns `discarded` " +
    "(how many were dropped) and `total` (buffer size).",
  inputSchema: z.object({
    arks: z
      .array(arkSchema)
      .min(1)
      .max(5_000)
      .describe("BnF ARK identifiers to discard from the buffer."),
  }),
  handler: async (input, ctx) => {
    const projectId = await projectIdFromSession(ctx.appSessionId)
    const discarded = await BufferService.discard(projectId, input.arks)
    const total = await emitBuffer(ctx, projectId, "removed", discarded)
    return { discarded, total }
  },
})

// ---------------------------------------------------------------------------
// buffer_commit
// ---------------------------------------------------------------------------

export const bufferCommitTool = defineTool<
  z.ZodObject<{ reason: z.ZodString }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.bufferCommit,
  description:
    "Commit the buffer's candidates into the project's corpus in one operation — " +
    "this is how staged candidates become real corpus members. It advances the " +
    "corpus version (like corpus_add) and their BnF metadata resolves in the " +
    "BACKGROUND afterwards. Committed candidates are marked committed and leave the " +
    "active buffer. Commit once the buffered set matches the librarian's stated " +
    "scope — do not wait to be told for every add. For a LARGE buffer, state the " +
    "count and confirm with the librarian first (a commit grows the corpus and is " +
    "not trivially reversible). Result: `committed` (candidates moved in), " +
    "`duplicates` (already in the corpus), `versionSeq`, `total` (new corpus size), " +
    "`pending` (added docs still resolving).",
  inputSchema: z.object({
    reason: z
      .string()
      .trim()
      .min(1)
      .max(CORPUS_REASON_MAX_LEN)
      .describe(
        "Short reason, stored as the corpus version note — ONE sentence (the " +
          "librarian's intent, e.g. « presse parisienne, été 1889 »). Do not paste a paragraph.",
      ),
  }),
  handler: async (input, ctx) => {
    const projectId = await projectIdFromSession(ctx.appSessionId)
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })

    const result = await BufferService.commit(project, ctx.user, {
      sessionId: ctx.appSessionId,
      reason: input.reason,
    })

    // Background metadata resolution for the newly-added stubs + cb→Gallica
    // upgrade for any catalogue notices — same detachment/discipline as
    // corpus_add. kickCanonicalize is a fast no-op when nothing is pending.
    if (result.corpus.pending > 0) kickResolve(projectId)
    kickCanonicalize(projectId)

    // The corpus grew → refresh the corpus panel; the buffer emptied → refresh
    // the buffer panel.
    if (result.corpus.lastDeltaAdded > 0) {
      ctx.emit?.({
        type: "corpus_event",
        data: {
          kind: "add",
          count: result.corpus.lastDeltaAdded,
          versionSeq: result.corpus.versionSeq,
        },
      })
    }
    const total = await emitBuffer(ctx, projectId, "committed", result.committed)

    return {
      committed: result.corpus.lastDeltaAdded,
      duplicates: result.duplicates,
      versionSeq: result.corpus.versionSeq,
      total: result.corpus.total,
      pending: result.corpus.pending,
      bufferRemaining: total,
    }
  },
})

// ---------------------------------------------------------------------------
// buffer_clear
// ---------------------------------------------------------------------------

export const bufferClearTool = defineTool<z.ZodObject<Record<string, never>>, TurnScopedCtx>({
  name: AGENT_TOOLS.bufferClear,
  description:
    "Empty the research buffer for a fresh line of inquiry — drops all current " +
    "candidates (and previously-discarded rows). Does NOT touch the corpus (only " +
    "the pre-commit staging area). Use when the librarian wants to start a new " +
    "search from scratch. Returns `cleared` (rows removed).",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const projectId = await projectIdFromSession(ctx.appSessionId)
    const cleared = await BufferService.clear(projectId)
    await emitBuffer(ctx, projectId, "cleared", cleared)
    return { cleared }
  },
})

// ---------------------------------------------------------------------------
// corpus_search — BnF catalogue/Gallica search that funnels hits into the buffer
// ---------------------------------------------------------------------------

/** MCP search pagination block (bnf_search_gallica / bnf_search_catalogue). */
interface BnfSearchPagination {
  total: number
  count: number
  has_more: boolean
  next_start_record?: number
  start_record: number
}
/** One Gallica hit (bnf_search_gallica → data.data.results[]). */
interface GallicaHit {
  ark: string
  title: string | null
  creator: string | null
  date: string | null
  description: string | null
  doc_type: string | null
  language: string | null
}
/** One catalogue hit (bnf_search_catalogue → data.data.records[]). No doc_type. */
interface CatalogueHit {
  ark: string
  title: string | null
  author: string | null
  date: string | null
  publisher: string | null
  language: string | null
}
interface GallicaPayload {
  data: { results: GallicaHit[] }
  pagination: BnfSearchPagination
}
interface CataloguePayload {
  data: { records: CatalogueHit[] }
  pagination: BnfSearchPagination
}

/** Bare local ARK id (e.g. "bpt6k…") → the canonical `ark:/12148/…` form. */
function toFullArk(bare: string): string {
  return bare.startsWith("ark:/") ? bare : `ark:/12148/${bare}`
}
/** Trim to a non-empty string, or undefined. */
function clean(value: string | null | undefined): string | undefined {
  const t = value?.trim()
  return t && t.length > 0 ? t : undefined
}
/** Map a search hit's free-text date to a year, or undefined. */
function toYear(date: string | null): number | undefined {
  return parseBnfDate(date).year ?? undefined
}

const searchSourceEnum = z.enum(["gallica", "catalogue"])

export const corpusSearchTool = defineTool<
  z.ZodObject<{
    source: typeof searchSourceEnum
    query: z.ZodOptional<z.ZodString>
    title: z.ZodOptional<z.ZodString>
    creator: z.ZodOptional<z.ZodString>
    date: z.ZodOptional<z.ZodString>
    doc_type: z.ZodOptional<z.ZodString>
    language: z.ZodOptional<z.ZodString>
    start_record: z.ZodOptional<z.ZodNumber>
    maximum_records: z.ZodOptional<z.ZodNumber>
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.corpusSearch,
  description:
    "Search the BnF (Gallica full text or the catalogue) AND stage every hit in " +
    "the research buffer in one step — this is your PRIMARY way to find documents. " +
    "Prefer it over the raw bnf_search_* tools: it persists candidates to the " +
    "visible buffer (so the librarian can curate them) instead of returning a long " +
    "list into the conversation. Pick `source`: \"gallica\" for digitised full-text " +
    "documents, \"catalogue\" for bibliographic records. Give at least one of " +
    "query / title / creator / date. It returns a COMPACT summary — total available, " +
    "how many were added to the buffer, the buffer size, and a small sample — NOT " +
    "the full result list; inspect the staged candidates with buffer_stats / " +
    "buffer_list. To gather more, call again with `start_record` advanced by the " +
    "page size (use the returned `next_start_record`) until `has_more` is false. " +
    "Curate with buffer_remove_by_filter, then buffer_commit to add them to the corpus.",
  inputSchema: z.object({
    source: searchSourceEnum.describe(
      'Which BnF index: "gallica" (digitised full text) or "catalogue" (bibliographic).',
    ),
    query: z.string().trim().min(1).optional().describe("Free-text search terms."),
    title: z.string().trim().min(1).optional().describe("Match on title."),
    creator: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Match on author/creator (mapped to author for the catalogue)."),
    date: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Exact year, e.g. "1889" (the BnF SRU date filter is year-exact).'),
    doc_type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Gallica only — one of: monographie, image, carte, manuscrit, fascicule, " +
          "partition, video, son, typeAffiche. Ignored for the catalogue.",
      ),
    language: z.string().trim().min(1).optional().describe("Language code to restrict to."),
    start_record: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("1-based offset for pagination (use the returned next_start_record). Default 1."),
    maximum_records: z
      .number()
      .int()
      .min(1)
      .max(BUFFER_SEARCH_MAX_PAGE_SIZE)
      .optional()
      .describe(`Page size (1–${BUFFER_SEARCH_MAX_PAGE_SIZE}, default ${BUFFER_SEARCH_PAGE_SIZE}).`),
  }),
  handler: async (input, ctx) => {
    // At least one search term (kept out of the Zod schema so the failure is a
    // clean tool result the agent can react to, not a hard validation throw).
    if (!input.query && !input.title && !input.creator && !input.date) {
      return { error: "Fournissez au moins un critère de recherche : query, title, creator ou date." }
    }

    let mcpEnv: { BNF_MCP_URL: string; BNF_MCP_TOKEN: string }
    try {
      mcpEnv = requireMcpEnv()
    } catch {
      return {
        error:
          "La recherche BnF est indisponible (le MCP BnF n'est pas configuré pour cette session).",
      }
    }

    const projectId = await projectIdFromSession(ctx.appSessionId)
    const pageSize = input.maximum_records ?? BUFFER_SEARCH_PAGE_SIZE
    const startRecord = input.start_record ?? 1

    // Build the per-source MCP args (catalogue has no creator/doc_type: creator
    // maps to `author`, doc_type is dropped). Only send provided fields.
    const common: Record<string, unknown> = {
      response_format: "json",
      start_record: startRecord,
      maximum_records: pageSize,
    }
    if (input.query) common.query = input.query
    if (input.title) common.title = input.title
    if (input.date) common.date = input.date
    if (input.language) common.language = input.language

    let candidates: BufferCandidateInput[]
    let pagination: BnfSearchPagination
    try {
      if (input.source === "gallica") {
        const args = { ...common }
        if (input.creator) args.creator = input.creator
        if (input.doc_type) args.doc_type = input.doc_type
        const payload = await callBnfTool<GallicaPayload>(
          mcpEnv.BNF_MCP_URL,
          mcpEnv.BNF_MCP_TOKEN,
          "bnf_search_gallica",
          args,
          ctx.signal,
        )
        pagination = payload.pagination
        candidates = payload.data.results.map((h) => {
          const ark = toFullArk(h.ark)
          return {
            ark,
            title: clean(h.title),
            year: toYear(h.date),
            docType: clean(h.doc_type),
            lang: clean(h.language),
            source: sourceFromArk(ark),
            snippet: clean(h.description),
          }
        })
      } else {
        const args = { ...common }
        if (input.creator) args.author = input.creator
        const payload = await callBnfTool<CataloguePayload>(
          mcpEnv.BNF_MCP_URL,
          mcpEnv.BNF_MCP_TOKEN,
          "bnf_search_catalogue",
          args,
          ctx.signal,
        )
        pagination = payload.pagination
        candidates = payload.data.records.map((h) => {
          const ark = toFullArk(h.ark)
          return {
            ark,
            title: clean(h.title),
            year: toYear(h.date),
            // The catalogue payload carries no doc_type; leave it for the
            // background resolver to fill in after commit.
            lang: clean(h.language),
            source: sourceFromArk(ark),
          }
        })
      }
    } catch (err) {
      // Coerce the transport/tool failure into a structured tool result the
      // agent can react to (CLAUDE_ERROR_PATTERNS §15) — never throw out.
      const message = err instanceof BnfMcpError ? err.message : String(err)
      return { error: `La recherche BnF a échoué : ${message}` }
    }

    const registered = await BufferService.registerCandidates({
      projectId,
      sessionId: ctx.appSessionId,
      originTool: AGENT_TOOLS.corpusSearch,
      originQuery: input.query ?? input.title ?? input.creator ?? input.date ?? null,
      candidates,
    })

    const buffered = await emitBuffer(ctx, projectId, "added", registered.added)

    return {
      source: input.source,
      total: pagination.total,
      found: candidates.length,
      added: registered.added,
      refreshed: registered.refreshed,
      buffered,
      has_more: pagination.has_more,
      ...(pagination.next_start_record !== undefined
        ? { next_start_record: pagination.next_start_record }
        : {}),
      sample: candidates.slice(0, 8).map((c) => ({
        ark: c.ark,
        title: c.title ?? null,
        year: c.year ?? null,
      })),
    }
  },
})

// Convenience array for the registry builder — the whole buffer tool set,
// corpus_search included (it is the buffer's populator).
export const bufferTools = [
  corpusSearchTool,
  bufferListTool,
  bufferStatsTool,
  bufferRemoveByFilterTool,
  bufferAddTool,
  bufferDiscardTool,
  bufferCommitTool,
  bufferClearTool,
] as const
