/**
 * Corpus tool definitions for the BnF corpus agent.
 *
 * Five tools covering the full lifecycle of corpus mutations and inspection:
 *   - corpus_get_state  — full snapshot (facets + sample) of the current head
 *   - corpus_add        — add ARKs, advancing the version
 *   - corpus_remove     — remove ARKs, advancing the version
 *   - corpus_stats      — lightweight facet-only view (no sample)
 *   - corpus_diff       — compare two version seqs
 *
 * Every mutating tool publishes a `corpus_event` via `ctx.emit` so connected
 * SSE clients receive real-time feedback without polling.
 *
 * ProjectId resolution: resolved lazily from the session row rather than
 * baked into the closure at registry-construction time. This keeps the lookup
 * parallel-safe (no shared mutable state) and avoids a stale projectId if a
 * session were somehow re-used across projects.
 */
import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import { CORPUS_REASON_MAX_LEN } from "@/lib/constants"
import { prisma } from "@/lib/db"
import { kickCanonicalize } from "@/lib/documents/canonicalizer"
import { kickResolve } from "@/lib/documents/resolver"
import { sourceFromArk } from "@/lib/mcp/vocab"
import { CorpusQueries } from "@/models/corpus/queries"
import { CorpusService } from "@/models/corpus/service"
import { arkSchema } from "@/models/corpus/types"
import type { CorpusFilterSet } from "@/models/corpus/queries"
import type { TurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS } from "./constants"

// ---------------------------------------------------------------------------
// Shared filter schema (corpus_get_state, corpus_list, corpus_stats,
// corpus_remove_by_filter all accept the same metadata filter set)
// ---------------------------------------------------------------------------

/** Numérisation / ingestion classes — the derived ingestability buckets. */
const ingestClassEnum = z.enum(["ocr", "vision", "sans_texte", "non_numerise"])

/**
 * The metadata filter set the corpus agent passes to narrow a read or a bulk
 * removal. Mirrors `CorpusFilterSet` (models/corpus/queries.ts) minus `session`
 * (a UI-only attribution facet the agent has no use for). All fields optional;
 * absent means "no constraint on this dimension". Multi-select dimensions are
 * arrays (pass one or several values).
 */
const corpusFiltersSchema = z
  .object({
    type: z
      .array(z.string())
      .optional()
      .describe('Doc-type codes to keep, e.g. ["book","periodique"].'),
    lang: z
      .array(z.string())
      .optional()
      .describe('BCP-47 language codes to keep, e.g. ["fr","la"].'),
    source: z
      .array(z.string())
      .optional()
      .describe('Sources to keep: "gallica" | "catalogue" | "other".'),
    ingest: z
      .array(ingestClassEnum)
      .optional()
      .describe(
        "Numérisation classes to keep: ocr | vision | sans_texte | non_numerise.",
      ),
    yearFrom: z
      .number()
      .int()
      .optional()
      .describe("Year lower bound, inclusive (e.g. 1970)."),
    yearTo: z
      .number()
      .int()
      .optional()
      .describe("Year upper bound, inclusive (e.g. 2025)."),
    undated: z
      .boolean()
      .optional()
      .describe(
        "Keep only documents with an unknown date. Ignored when yearFrom/yearTo is set.",
      ),
    q: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Free-text match over title, author, and excerpt."),
  })
  .describe("Metadata filters. Omit a field to leave that dimension unconstrained.")

/** The document fields corpus_list may project. `ark` is always returned. */
const corpusListFieldEnum = z.enum([
  "title",
  "author",
  "year",
  "dateLabel",
  "docType",
  "lang",
  "source",
  "pages",
  "resolveStatus",
])

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Resolve the projectId for a given appSession.
 *
 * Using a direct Prisma query rather than a service method keeps this module
 * free of circular imports. The lookup is a single primary-key read — cheap.
 *
 * Throws if the session does not exist (programming error; sessions are created
 * before the registry is built).
 */
async function projectIdFromSession(appSessionId: string): Promise<string> {
  const session = await prisma.appSession.findUniqueOrThrow({
    where: { id: appSessionId },
    select: { projectId: true },
  })
  return session.projectId
}

// ---------------------------------------------------------------------------
// corpus_get_state
// ---------------------------------------------------------------------------

export const corpusGetStateTool = defineTool<
  z.ZodObject<{
    include_sample: z.ZodOptional<z.ZodBoolean>
    sample_limit: z.ZodOptional<z.ZodNumber>
    filters: z.ZodOptional<typeof corpusFiltersSchema>
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.corpusGetState,
  description:
    "Retrieve the current corpus state for this project: total document count, " +
    "facets (type, language, source, period), and an optional paginated document sample. " +
    "Call this at the start of each corpus session to orient yourself, and after mutations " +
    "to verify the result. Pass include_sample=false when you only need counts/facets. " +
    "Pass `filters` to scope the total, facets, AND sample to a subset (e.g. " +
    '`{"filters":{"yearFrom":1970}}` to see only documents from 1970 onward) — ' +
    "every count shrinks to the filtered set. For exhaustively enumerating a " +
    "filtered subset page by page, prefer corpus_list.",
  inputSchema: z.object({
    include_sample: z
      .boolean()
      .optional()
      .describe("Whether to include a document sample. Default true."),
    sample_limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum number of sample documents to return (1–100, default 25)."),
    filters: corpusFiltersSchema.optional(),
  }),
  handler: async (input, ctx) => {
    const includeSample = input.include_sample ?? true
    const sampleLimit = input.sample_limit
    const filters = input.filters as CorpusFilterSet | undefined
    const projectId = await projectIdFromSession(ctx.appSessionId)
    const snapshot = await CorpusQueries.snapshot(
      projectId,
      "head",
      includeSample ? { filters, limit: sampleLimit } : { filters, limit: 0 },
    )
    if (!includeSample) {
      const { sample: _sample, ...rest } = snapshot
      return rest
    }
    return snapshot
  },
})

// ---------------------------------------------------------------------------
// corpus_list
// ---------------------------------------------------------------------------

export const corpusListTool = defineTool<
  z.ZodObject<{
    filters: z.ZodOptional<typeof corpusFiltersSchema>
    cursor: z.ZodOptional<z.ZodString>
    limit: z.ZodOptional<z.ZodNumber>
    fields: z.ZodOptional<z.ZodArray<typeof corpusListFieldEnum>>
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.corpusList,
  description:
    "List the corpus documents matching `filters`, one page at a time, with NO " +
    "facets (faster than corpus_get_state — use this to ENUMERATE documents, not " +
    "to get aggregate stats). Returns `total` (count within the filters), " +
    "`documents` (one page), and `nextCursor`. To walk the whole filtered set, " +
    "call again passing the returned `nextCursor` until it is absent — never stop " +
    "at the first page when the librarian asked to be exhaustive. Use `fields` to " +
    "request only the columns you need (ark is always included) to keep responses " +
    "compact. This is the right tool for 'show me every document from 1970 onward' " +
    "or 'which catalogue notices are in the corpus' — filter, then page through.",
  inputSchema: z.object({
    filters: corpusFiltersSchema.optional(),
    cursor: z
      .string()
      .optional()
      .describe(
        "Opaque pagination cursor from a previous call's `nextCursor`. Omit for the first page.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Page size (1–200, default 25)."),
    fields: z
      .array(corpusListFieldEnum)
      .optional()
      .describe(
        "Document fields to return besides `ark` (always included). Omit to return all fields.",
      ),
  }),
  handler: async (input, ctx) => {
    const filters = input.filters as CorpusFilterSet | undefined
    const projectId = await projectIdFromSession(ctx.appSessionId)
    const page = await CorpusQueries.list(projectId, "head", {
      filters,
      cursor: input.cursor,
      limit: input.limit,
    })

    // Project each document down to the requested fields (token economy). `ark`
    // is always kept so the agent can act on / cite the document. When no
    // `fields` are given, return the full row.
    const documents =
      input.fields && input.fields.length > 0
        ? page.documents.map((doc) => {
            const picked: Record<string, unknown> = { ark: doc.ark }
            for (const f of input.fields as (keyof typeof doc)[]) {
              picked[f] = doc[f]
            }
            return picked
          })
        : page.documents

    return {
      versionSeq: page.versionSeq,
      total: page.total,
      documents,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    }
  },
})

// ---------------------------------------------------------------------------
// corpus_add
// ---------------------------------------------------------------------------

export const corpusAddTool = defineTool<
  z.ZodObject<{
    arks: z.ZodArray<typeof arkSchema>
    reason: z.ZodString
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.corpusAdd,
  description:
    "Add one or more documents (identified by ARK) to the project's corpus. " +
    "The add is INSTANT — documents join the corpus immediately and a new corpus " +
    "version is created. Their BnF metadata (title, date, type, language) is then " +
    "resolved in the BACKGROUND, so this returns before resolution completes. " +
    "ARKs must be valid BnF ARKs (format: ark:/12148/<name>). The reason is stored " +
    "as a version note describing why these documents are relevant. " +
    "IMPORTANT — do NOT pre-filter, cross-reference, or deduplicate against the " +
    "current corpus yourself: pass EVERY ARK you found in one call. This tool " +
    "deduplicates server-side (against the corpus and within the batch) and tells " +
    "you what actually happened — never reason about uniqueness in your head. " +
    "Result fields: `requested` (ARKs you supplied), `added` (newly added this " +
    "call), `duplicates` (supplied ARKs skipped because already present or " +
    "repeated; requested = added + duplicates), `total` (corpus size), `pending` " +
    "(added docs still resolving in the background — tell the librarian their " +
    "metadata is being fetched and will appear shortly). " +
    "Do NOT judge or filter documents by 'ingestability' here — whether a " +
    "document will be indexed as full text is decided automatically at the later " +
    "ingestion step, not during corpus building. Every real BnF ARK is valid; " +
    "never describe ARKs as valid/invalid or ingestable/non-ingestable. " +
    "Catalogue notices are handled for you: if you add a `cb…` notice that the " +
    "BnF has digitized, it is upgraded automatically to its digitized Gallica " +
    "document (`bpt6k…`/`btv1b…`) in the BACKGROUND, shortly after this returns — " +
    "so just add the `cb…` ARK as-is; you do NOT need to resolve it to its " +
    "Gallica form yourself, and you do NOT need to wait for the upgrade.",
  inputSchema: z.object({
    arks: z
      .array(arkSchema)
      .min(1)
      .max(5_000)
      .describe(
        "List of BnF ARK identifiers to add (e.g. [\"ark:/12148/bpt6k2839841\"]).",
      ),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(CORPUS_REASON_MAX_LEN)
      .describe(
        "Short reason for adding these documents — ONE sentence, stored as the " +
          "version note. Keep it brief (the librarian's intent, e.g. « presse " +
          "parisienne 1871 sur la Commune »); do not restate every ARK or paste a " +
          "paragraph.",
      ),
  }),
  handler: async (input, ctx) => {
    const projectId = await projectIdFromSession(ctx.appSessionId)

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
    })

    const result = await CorpusService.addArks(
      project,
      ctx.user,
      {
        arks: input.arks,
        reason: input.reason,
      },
      // Record per-session attribution: tag every added ARK with this session
      // so the corpus can later be filtered by which session contributed it.
      ctx.appSessionId,
      // Upgrade catalogue notices (cb…) to their digitized Gallica doc when one
      // exists, so the corpus member is the consultable/citable/ingestable form.
      { canonicalize: true },
    )

    // Resolve the newly-added stubs' metadata in the background, after this
    // turn's response is flushed. Detached from the request — its MCP calls are
    // individually timeout-bounded.
    if (result.pending > 0) kickResolve(projectId)

    // Upgrade any added catalogue notices (cb…) to their digitized Gallica doc
    // in the background too — same detachment, so a cb-heavy batch never stalls
    // the turn on rate-limited data.bnf.fr/SRU lookups. The drain is a fast
    // no-op when nothing is pending, so only kick it when a notice was supplied.
    if (input.arks.some((a) => sourceFromArk(a) === "catalogue")) {
      kickCanonicalize(projectId)
    }

    ctx.emit?.({
      type: "corpus_event",
      data: {
        kind: "add",
        count: result.lastDeltaAdded,
        versionSeq: result.versionSeq,
      },
    })

    // Note: `result.nonIngestable` is intentionally NOT surfaced — ingestability
    // is an ingestion-step concern, not a corpus-building one. The agent must not
    // filter or warn on it here.
    return {
      requested: result.requested,
      added: result.lastDeltaAdded,
      duplicates: result.duplicates,
      versionSeq: result.versionSeq,
      total: result.total,
      pending: result.pending,
    }
  },
})

// ---------------------------------------------------------------------------
// corpus_remove
// ---------------------------------------------------------------------------

export const corpusRemoveTool = defineTool<
  z.ZodObject<{
    arks: z.ZodArray<typeof arkSchema>
    reason: z.ZodString
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.corpusRemove,
  description:
    "Remove one or more documents (identified by ARK) from the project's corpus. " +
    "Creates a new immutable corpus version. Documents not currently in the corpus " +
    "are silently ignored. Removing a document does NOT delete it from the database — " +
    "it only removes its membership in the current version.",
  inputSchema: z.object({
    arks: z
      .array(arkSchema)
      .min(1)
      .max(5_000)
      .describe("List of BnF ARK identifiers to remove."),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(CORPUS_REASON_MAX_LEN)
      .describe(
        "Short reason for removing these documents — ONE sentence, stored as the " +
          "version note. Keep it brief; do not restate every ARK.",
      ),
  }),
  handler: async (input, ctx) => {
    const projectId = await projectIdFromSession(ctx.appSessionId)

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
    })

    const result = await CorpusService.removeArks(project, ctx.user, {
      arks: input.arks,
      reason: input.reason,
    })

    ctx.emit?.({
      type: "corpus_event",
      data: {
        kind: "remove",
        count: result.lastDeltaRemoved,
        versionSeq: result.versionSeq,
      },
    })

    return {
      removed: result.lastDeltaRemoved,
      versionSeq: result.versionSeq,
      total: result.total,
    }
  },
})

// ---------------------------------------------------------------------------
// corpus_remove_by_filter
// ---------------------------------------------------------------------------

export const corpusRemoveByFilterTool = defineTool<
  z.ZodObject<{
    filters: typeof corpusFiltersSchema
    reason: z.ZodString
    dry_run: z.ZodOptional<z.ZodBoolean>
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.corpusRemoveByFilter,
  description:
    "Remove EVERY document matching a metadata filter from the corpus in one " +
    "operation — the bulk counterpart to corpus_remove (which needs explicit " +
    "ARKs). Use it to drop a whole sub-population the librarian wants out (e.g. " +
    '"les notices catalogue postérieures à 1970": ' +
    '`{"filters":{"yearFrom":1970,"source":["catalogue"]}}`). ' +
    "ALWAYS preview first with dry_run=true (the default): it returns `matched` " +
    "(how many would be removed) and a sample of their ARKs WITHOUT changing " +
    "anything. Show the librarian that count, get confirmation, THEN call again " +
    "with dry_run=false to commit (which seals a new corpus version). An empty " +
    "filter is refused (status \"empty_filter\") — it would match the whole " +
    "corpus; narrow it instead. Removing a document drops its membership only; " +
    "it is never deleted from the database.",
  inputSchema: z.object({
    filters: corpusFiltersSchema,
    reason: z
      .string()
      .trim()
      .min(1)
      .max(CORPUS_REASON_MAX_LEN)
      .describe(
        "Short reason for the removal — ONE sentence, stored as the version note. " +
          "Keep it brief (the criterion, e.g. « notices catalogue postérieures à " +
          "1970 »); do not paste a paragraph.",
      ),
    dry_run: z
      .boolean()
      .optional()
      .describe(
        "When true (default), preview only — report what would be removed without mutating. Set false to commit.",
      ),
  }),
  handler: async (input, ctx) => {
    const projectId = await projectIdFromSession(ctx.appSessionId)
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
    })

    // Preview-first: dry_run defaults to true so an unconfirmed call never
    // mutates the corpus.
    const dryRun = input.dry_run ?? true

    const result = await CorpusService.removeByFilter(project, ctx.user, {
      filters: input.filters as CorpusFilterSet,
      reason: input.reason,
      dryRun,
    })

    // Only a committed removal emits a corpus_event and advances a version.
    if (result.status === "removed" && result.removed > 0) {
      ctx.emit?.({
        type: "corpus_event",
        data: {
          kind: "remove",
          count: result.removed,
          versionSeq: result.versionSeq,
        },
      })
    }

    return result
  },
})

// ---------------------------------------------------------------------------
// corpus_stats
// ---------------------------------------------------------------------------

const facetDimensionEnum = z.enum(["period", "type", "lang", "source"])

export const corpusStatsTool = defineTool<
  z.ZodObject<{
    filters: z.ZodOptional<typeof corpusFiltersSchema>
    cross_facets: z.ZodOptional<z.ZodTuple<[typeof facetDimensionEnum, typeof facetDimensionEnum]>>
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.corpusStats,
  description:
    "Return facet counts (type, language, source, period) and total document count " +
    "for the current corpus — without a document sample. Faster than corpus_get_state " +
    "when you only need aggregate statistics. Pass `filters` to scope every count to " +
    "a subset. Pass `cross_facets` (a pair of dimensions, e.g. [\"period\",\"type\"]) " +
    "to ALSO get a crossed breakdown — the count for each combination (e.g. how many " +
    "1970s books vs. 1970s periodicals). Crossing period × type or period × source is " +
    "the fastest way to locate a sub-population (\"the recent documents are catalogue " +
    "books\") without inspecting documents one by one.",
  inputSchema: z.object({
    filters: corpusFiltersSchema.optional(),
    cross_facets: z
      .tuple([facetDimensionEnum, facetDimensionEnum])
      .optional()
      .describe(
        'Two dimensions to cross-tabulate, e.g. ["period","type"] or ["period","source"].',
      ),
  }),
  handler: async (input, ctx) => {
    const filters = input.filters as CorpusFilterSet | undefined
    const projectId = await projectIdFromSession(ctx.appSessionId)
    const snapshot = await CorpusQueries.snapshot(projectId, "head", {
      filters,
      limit: 0,
    })
    const { sample: _sample, ...stats } = snapshot

    if (!input.cross_facets) return stats

    const cross = await CorpusQueries.crossFacets(
      projectId,
      "head",
      [input.cross_facets[0], input.cross_facets[1]],
      filters,
    )
    return { ...stats, cross }
  },
})

// ---------------------------------------------------------------------------
// corpus_diff
// ---------------------------------------------------------------------------

export const corpusDiffTool = defineTool<
  z.ZodObject<{
    from_seq: z.ZodNumber
    to_seq: z.ZodNumber
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.corpusDiff,
  description:
    "Compare two corpus versions and return the list of ARKs added and removed " +
    "between them. Useful for explaining to the librarian what changed across sessions.",
  inputSchema: z.object({
    from_seq: z
      .number()
      .int()
      .positive()
      .describe("The earlier version sequence number (from)."),
    to_seq: z
      .number()
      .int()
      .positive()
      .describe("The later version sequence number (to)."),
  }),
  handler: async (input, ctx) => {
    const projectId = await projectIdFromSession(ctx.appSessionId)
    return CorpusQueries.diff(projectId, input.from_seq, input.to_seq)
  },
})

// Convenience array for the registry builder.
export const corpusTools = [
  corpusGetStateTool,
  corpusListTool,
  corpusAddTool,
  corpusRemoveTool,
  corpusRemoveByFilterTool,
  corpusStatsTool,
  corpusDiffTool,
] as const
