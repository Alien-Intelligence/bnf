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
 * advances the corpus. Every MUTATING tool authorises through BufferPolicy
 * first (lib/agent/tools/authorize.ts) and acts on the project it returns —
 * loaded with its shares; the read tools use `ctx.projectId`, which the route
 * resolved from the session row once per turn.
 */
import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import {
  BUFFER_LIST_MAX_LIMIT,
  BUFFER_SAMPLE_SIZE,
  BUFFER_SEARCH_DEFAULT_PAGE_SIZE_BY_SOURCE,
  BUFFER_SEARCH_MAX_PAGE_SIZE_BY_SOURCE,
  CORPUS_REASON_MAX_LEN,
  CORPUS_SEARCH_SAMPLE_SIZE,
} from "@/lib/constants"
import { kickCanonicalize } from "@/lib/documents/canonicalizer"
import { kickResolve } from "@/lib/documents/resolver"
import { kickBufferEnrich } from "@/lib/buffer/enricher"
import { requireMcpEnv } from "@/lib/env"
import { callBnfTool } from "@/lib/mcp/call"
import {
  BnfMcpError,
  BnfMcpQueryRefusedError,
  BnfMcpQuotaSaturatedError,
} from "@/lib/mcp/errors"
import { parseBnfDate } from "@/lib/mcp/normalize"
import { quotaSaturatedResult } from "@/lib/mcp/rate-limit"
import { BNF_SEARCH_TOOL } from "@/lib/mcp/tools"
import {
  GALLICA_COLLAPSING_DEFAULT,
  GALLICA_SEARCHABLE_DOC_TYPE,
  GALLICA_SORT_KEYS,
  canonicalLang,
  sourceFromArk,
} from "@/lib/mcp/vocab"
import {
  BUFFER_SUBJECTS_SEPARATOR,
  canonicalBufferDocType,
  gallicaSearchDocType,
  yearEndFromLabel,
  type GallicaSearchDocType,
} from "@/lib/buffer/classify"
import { classifyArkKind } from "@/lib/documents/ark-kind"
import { DOCUMENT_SOURCE } from "@/models/documents/schema"
import { BufferPolicy } from "@/models/buffer/policy"
import { BufferQueries } from "@/models/buffer/queries"
import { BufferService, explainRegistration, type BufferRegisterResult } from "@/models/buffer/service"
import {
  arkSchema,
  bufferFilterSetSchema as bufferFilterSchema,
  type BufferCandidateInput,
  type BufferFilterSet,
} from "@/models/buffer/types"
import type { TurnScopedCtx } from "./registry-factory"
import { authorizeProjectTool } from "./authorize"
import { REMOVE_BY_FILTER_STATUS } from "@/lib/filters"
import {
  EMPTY_FILTER_REFUSAL,
  INVALID_PARAMS_REFUSAL,
  refusingBadFilterValues,
  QUERY_NOT_EXPRESSIBLE_REFUSAL,
  toolFailure,
  toolRefusal,
  type ToolRefusal,
} from "./failure"
import {
  BUFFER_EVENT_KIND,
  CORPUS_EVENT_KIND,
  emitDomainEvent,
  STREAM_DOMAIN_EVENT,
  type BufferEventKind,
} from "@/lib/agent/stream-events"
import { AGENT_TOOLS } from "./constants"
import { provisionalTotal } from "./provisional-total"

const facetDimensionEnum = z.enum(["period", "type", "kind", "lang", "source"])

/**
 * The counts every staging tool returns, so it always says what became of each
 * hit — and, whenever `added` is below what was found, why (`explanation`).
 */
function stagingCounts(found: number, r: BufferRegisterResult) {
  const explanation = explainRegistration(found, r)
  return {
    added: r.added,
    restaged: r.restaged,
    refreshed: r.refreshed,
    alreadyInCorpus: r.alreadyInCorpus,
    previouslyDiscarded: r.previouslyDiscarded,
    unresolved: r.unresolved,
    ...(explanation !== null ? { explanation } : {}),
  }
}

/** Record kinds in one search page, for the compact result. */
function countKinds(candidates: BufferCandidateInput[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of candidates) {
    if (c.arkKind !== undefined) out[c.arkKind] = (out[c.arkKind] ?? 0) + 1
  }
  return out
}

/** Publish a buffer_event carrying the post-op candidate total. */
async function emitBuffer(
  ctx: TurnScopedCtx,
  projectId: string,
  kind: BufferEventKind,
  count: number,
): Promise<number> {
  const total = await BufferService.count(projectId)
  emitDomainEvent(ctx, { type: STREAM_DOMAIN_EVENT.BUFFER, data: { kind, count, total } })
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
  inputSchema: z.strictObject({
    filters: bufferFilterSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(BUFFER_LIST_MAX_LIMIT)
      .optional()
      .describe(`Page size (1–${BUFFER_LIST_MAX_LIMIT}, default ${BUFFER_SAMPLE_SIZE}).`),
  }),
  handler: (input, ctx) =>
    // A filter value the data refuses → an invalid_params refusal (failure.ts).
    refusingBadFilterValues(async () => {
      const [{ total, rows }, enrich, notUnknown] = await Promise.all([
        BufferService.list(ctx.projectId, input.filters, input.limit ?? BUFFER_SAMPLE_SIZE),
        BufferQueries.enrichCounts(ctx.projectId),
        notUnknownFor(ctx.projectId, input.filters),
      ])
      return { total, ...enrich, ...notUnknown, candidates: rows }
    }),
})

/**
 * With a `not`: per named dimension, the candidates it left out because their
 * value is unknown (Decision 4) — every read reports them, as a dry run does,
 * so nothing disappears silently.
 */
async function notUnknownFor(
  projectId: string,
  filters: BufferFilterSet | undefined,
): Promise<{ notUnknown?: Record<string, number> }> {
  if (filters?.not === undefined) return {}
  return { notUnknown: await BufferService.notUnknownCounts(projectId, filters) }
}

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
  inputSchema: z.strictObject({
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
  handler: (input, ctx) =>
    // A filter value the data refuses → an invalid_params refusal (failure.ts).
    refusingBadFilterValues(async () => {
      const projectId = ctx.projectId
      const filters = input.filters
      const [snapshot, enrich, notUnknown] = await Promise.all([
        BufferService.snapshot(projectId, filters, 0),
        BufferQueries.enrichCounts(projectId),
        notUnknownFor(projectId, filters),
      ])
      const stats = { total: snapshot.total, ...enrich, ...notUnknown, facets: snapshot.facets }

      if (!input.cross_facets) return stats

      const cross = await BufferService.crossFacets(
        projectId,
        [input.cross_facets[0], input.cross_facets[1]],
        filters,
      )
      return { ...stats, cross }
    }),
})

// ---------------------------------------------------------------------------
// buffer_remove_by_filter
// ---------------------------------------------------------------------------

/** The model-readable reason an empty remove-by-filter is refused. */
const BUFFER_EMPTY_FILTER_ERROR =
  "Filtre vide refusé : il retirerait tout le tampon. Précise un critère, " +
  "ou utilise buffer_clear pour vider le tampon explicitement."

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
    "to prune a sub-population before committing. Same semantics as " +
    "corpus_remove_by_filter: it removes what MATCHES the filter. Examples — drop the " +
    "colonial press: `{\"filters\":{\"kind\":[\"periodical_issue\"],\"title\":[\"Oran\"," +
    "\"Alger\",\"Constantine\",\"Maroc\",\"Tunis\",\"Indochine\",\"Madagascar\"," +
    "\"Tananarive\",\"Dakar\"]}}`; drop everything not in French: " +
    "`{\"filters\":{\"not\":{\"lang\":[\"fr\"]}}}` — candidates of unknown language are " +
    "KEPT and the dry run reports them as `notUnknown.lang`. ALWAYS preview " +
    "first with dry_run=true (the default) — it returns `matched` (how many would " +
    "be removed) and a sample of their ARKs WITHOUT changing anything; show the " +
    "librarian that count, then call again with dry_run=false to commit the " +
    "removal. An empty filter is refused (`success: false, refused: \"empty_filter\"`) — it would drop " +
    "the whole buffer; use buffer_clear for that, explicitly. Removed candidates " +
    "are discarded from the buffer, NOT the corpus (the buffer is pre-commit).",
  inputSchema: z.strictObject({
    filters: bufferFilterSchema,
    dry_run: z
      .boolean()
      .optional()
      .describe(
        "When true (default), preview only — report what would be removed without mutating. Set false to commit.",
      ),
  }),
  handler: (input, ctx) =>
    // A filter value the data refuses → an invalid_params refusal (failure.ts).
    refusingBadFilterValues(async () => {
      const dryRun = input.dry_run ?? true
      // A dry run only reads; the removal itself mutates the buffer.
      const gate = await authorizeProjectTool(ctx, BufferPolicy, dryRun ? "read" : "mutate")
      if (!gate.ok) return gate.result
      const projectId = gate.project.id

      const result = await BufferService.removeByFilter(projectId, {
        filters: input.filters,
        dryRun,
      })
      if (result.status === REMOVE_BY_FILTER_STATUS.EMPTY_FILTER) {
        return toolRefusal(EMPTY_FILTER_REFUSAL, BUFFER_EMPTY_FILTER_ERROR)
      }

      if (result.status === REMOVE_BY_FILTER_STATUS.REMOVED && result.removed > 0) {
        await emitBuffer(ctx, projectId, BUFFER_EVENT_KIND.REMOVED, result.removed)
      }

      return result
    }),
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
    "Stage specific ARKs the librarian names as buffer candidates, without a search. " +
    "Their metadata (title, date, type, kind) is resolved in the BACKGROUND — about 1 " +
    "minute per 100 ARKs, one BnF lookup per ARK — and filters cannot see a candidate " +
    "until it is resolved: check buffer_stats `unresolved` before filtering. Whenever a " +
    "search can produce the same documents, use corpus_search instead (for the press, " +
    "`doc_type: \"fascicule\"` + `collapsing: false`): it stages them WITH their metadata " +
    "at once. A previously discarded ARK named here is staged again. Returns `added`, " +
    "`alreadyInCorpus`, `unresolved` and `total` (buffer size).",
  inputSchema: z.strictObject({
    arks: z
      .array(arkSchema)
      .min(1)
      .max(5_000)
      .describe('BnF ARK identifiers to stage, e.g. ["ark:/12148/bpt6k2839841"].'),
  }),
  handler: async (input, ctx) => {
    const gate = await authorizeProjectTool(ctx, BufferPolicy, "mutate")
    if (!gate.ok) return gate.result
    const projectId = gate.project.id
    const result = await BufferService.registerCandidates({
      projectId,
      sessionId: ctx.appSessionId,
      originTool: AGENT_TOOLS.bufferAdd,
      // The librarian named these ARKs: a discarded one is staged again.
      restageDiscarded: true,
      candidates: input.arks.map((ark) => ({ ark })),
    })
    // A spawn_research child reports what IT staged (never a project-wide delta).
    if (ctx.stagingTally) ctx.stagingTally.added += result.added
    // Bare ARKs: their metadata is resolved out of band, never inline.
    if (result.unresolved > 0) kickBufferEnrich(projectId)
    const total = await emitBuffer(ctx, projectId, BUFFER_EVENT_KIND.ADDED, result.added)
    return {
      requested: result.requested,
      ...stagingCounts(input.arks.length, result),
      ...(result.unresolved > 0
        ? {
            enrichment: "background",
            enrichment_note:
              `${result.unresolved} candidat(s) sans métadonnées : résolution en arrière-plan ` +
              "(environ 1 minute pour 100 ARK). Les filtres ne s'appliquent à eux qu'une fois " +
              "résolus — vérifie `buffer_stats.unresolved` avant de filtrer.",
          }
        : {}),
      total,
    }
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
  inputSchema: z.strictObject({
    arks: z
      .array(arkSchema)
      .min(1)
      .max(5_000)
      .describe("BnF ARK identifiers to discard from the buffer."),
  }),
  handler: async (input, ctx) => {
    const gate = await authorizeProjectTool(ctx, BufferPolicy, "mutate")
    if (!gate.ok) return gate.result
    const projectId = gate.project.id
    const discarded = await BufferService.discard(projectId, input.arks)
    const total = await emitBuffer(ctx, projectId, BUFFER_EVENT_KIND.REMOVED, discarded)
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
    "`pending` (added docs still resolving), `canonicalizationPending` (catalogue notices " +
    "that may still be replaced by their digitized document) and `totalIsProvisional`. " +
    "When `totalIsProvisional` is true the total WILL move: call corpus_get_state and " +
    "quote that number, never this one.",
  inputSchema: z.strictObject({
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
    const gate = await authorizeProjectTool(ctx, BufferPolicy, "mutate")
    if (!gate.ok) return gate.result
    const project = gate.project
    const projectId = project.id

    const result = await BufferService.commit(project, ctx.user, {
      sessionId: ctx.appSessionId,
      reason: input.reason,
    })

    // Background metadata resolution for the newly-added stubs + cb→Gallica
    // upgrade for any committed catalogue notices — same detachment and the
    // same conditions as corpus_add: nothing is scheduled when nothing waits.
    if (result.corpus.pending > 0) kickResolve(projectId)
    if (result.catalogueNotices > 0) kickCanonicalize(projectId)

    // The corpus grew → refresh the corpus panel; the buffer emptied → refresh
    // the buffer panel.
    if (result.corpus.lastDeltaAdded > 0) {
      emitDomainEvent(ctx, {
        type: STREAM_DOMAIN_EVENT.CORPUS,
        data: {
          kind: CORPUS_EVENT_KIND.ADD,
          count: result.corpus.lastDeltaAdded,
          versionSeq: result.corpus.versionSeq,
        },
      })
    }
    const total = await emitBuffer(ctx, projectId, BUFFER_EVENT_KIND.COMMITTED, result.committed)

    return {
      committed: result.corpus.lastDeltaAdded,
      duplicates: result.duplicates,
      versionSeq: result.corpus.versionSeq,
      total: result.corpus.total,
      pending: result.corpus.pending,
      ...provisionalTotal(result.canonicalizationPending, result.corpus.pending),
      ...(result.committedUnresolved > 0 ? { committedUnresolved: result.committedUnresolved } : {}),
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
    "search from scratch. Returns `cleared` (rows removed). Committed candidates " +
    "are NOT dropped: they stay as provenance. While an ARK is in the corpus, a " +
    "search that finds it reports it in `alreadyInCorpus` (never as a new " +
    "candidate); once it is removed from the corpus, a search stages it again. So " +
    "clearing never makes `added` go up for documents already in the corpus — do " +
    "not clear to 'retry' a search that returned `alreadyInCorpus`.",
  inputSchema: z.strictObject({}),
  handler: async (_input, ctx) => {
    const gate = await authorizeProjectTool(ctx, BufferPolicy, "mutate")
    if (!gate.ok) return gate.result
    const projectId = gate.project.id
    const cleared = await BufferService.clear(projectId)
    await emitBuffer(ctx, projectId, BUFFER_EVENT_KIND.CLEARED, cleared)
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
/** One Gallica hit (bnf_search_gallica → data.data.results[], search_gallica.py). */
export interface GallicaHit {
  ark: string
  title: string | null
  creator: string | null
  date: string | null
  subject: string[] | null
  description: string | null
  doc_type: string | null
  language: string | null
  gallica_url: string | null
}
/** One catalogue hit (bnf_search_catalogue → data.data.records[]). No doc_type.
 *  `isbn` / `issn` are read but not stored (no filter needs them). */
export interface CatalogueHit {
  ark: string
  title: string | null
  author: string | null
  date: string | null
  publisher: string | null
  language: string | null
  isbn: string | null
  issn: string | null
  catalogue_url: string | null
  gallica_url: string | null
}
/** One thing the BnF refused, in its own words (mcp-bnf >= 0.4.0). */
interface BnfDiagnostic {
  uri: string
  message: string
  details: string
}
/** Fields every search payload carries, whatever the source. */
interface BnfSearchCommon {
  pagination: BnfSearchPagination
  /** The CQL actually sent — provenance for the buffer and the UI. */
  executed_cql?: string
  endpoint?: string
  collapsing?: boolean
  /** Present when the endpoint refused part of the query; explains a zero. */
  diagnostics?: BnfDiagnostic[]
}
interface GallicaPayload extends BnfSearchCommon {
  data: { results: GallicaHit[] }
}
interface CataloguePayload extends BnfSearchCommon {
  data: { records: CatalogueHit[] }
}

/**
 * Search-hit ARK → the canonical `ark:/12148/<id>` form, or null when the hit
 * carries no usable identifier.
 *
 * The BnF SRU returns bare local ids ("bpt6k…"), and for PERIODICALS it returns
 * the *collection* entry as `cb…/date` — the Gallica collection page, not a
 * document. Prefixing that verbatim yields `ark:/12148/cb…/date`, which is not a
 * valid ARK (it fails the corpus ARK contract) and is not an addressable
 * document. We keep the underlying catalogue notice (`cb…`), which IS a valid
 * corpus member and is auto-upgraded to its digitized doc by the canonicaliser;
 * the individual issues come from `bnf__bnf_get_periodical_issues`.
 */
function toFullArk(bare: string): string | null {
  const id = bare
    .trim()
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^ark:\/\d+\//, "")
    .replace(/\/.*$/, "") // drop trailing path segments ("/date", "/f1.item", …)
  if (!/^[A-Za-z0-9]+$/.test(id)) return null
  return `ark:/12148/${id}`
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

/** The last year of a range label ("1861-1946" → 1946), when it is after `year`. */
function toYearEnd(date: string | null, year: number | undefined): number | undefined {
  return yearEndFromLabel(date, year) ?? undefined
}

/** The `cb…/date` form: a Gallica PERIODICAL collection entry, not a document.
 *  Must be read on the raw identifier, before toFullArk strips the suffix. */
function isCollectionEntry(rawArk: string): boolean {
  return /\/date\/?$/.test(rawArk.trim())
}

/**
 * A Gallica hit → the buffer candidate, or null when it carries no usable
 * identifier. Every useful field is kept (feedback #10a: the filters need
 * them), and the type and kind are canonical at staging time:
 *   - docType: the search's own doc_type filter, else the folded dc:type label
 *     (Decision 2); the raw label is kept in docTypeRaw.
 *   - arkKind from the identifier form + type — the `/date` collection form is
 *     read before toFullArk strips it.
 *   - `typeAmbiguous`: a `text` hit from a search without doc_type — a
 *     monograph or a press issue, Gallica does not say which.
 */
export function candidateFromGallicaHit(
  h: GallicaHit,
  search: { docTypeFilter: GallicaSearchDocType | null; collapsing: boolean },
): (BufferCandidateInput & { typeAmbiguous: boolean }) | null {
  const ark = toFullArk(h.ark)
  if (ark === null) return null
  const docTypeRaw = clean(h.doc_type)
  const docType = canonicalBufferDocType(docTypeRaw, search.docTypeFilter)
  if (!docType.known) console.warn(`[corpus_search] unknown dc:type "${docTypeRaw}" → other`)
  const year = toYear(h.date)
  const subjects = (h.subject ?? []).map((v) => v.trim()).filter((v) => v !== "")
  return {
    ark,
    title: clean(h.title),
    creator: clean(h.creator),
    year,
    yearEnd: toYearEnd(h.date, year),
    dateLabel: clean(h.date),
    docType: docType.code ?? undefined,
    docTypeRaw,
    arkKind: classifyArkKind({ ark, collectionEntry: isCollectionEntry(h.ark), docType: docType.code }),
    lang: canonicalLang(h.language) ?? undefined,
    source: sourceFromArk(ark),
    snippet: clean(h.description),
    subjects: subjects.length > 0 ? subjects.join(BUFFER_SUBJECTS_SEPARATOR) : undefined,
    gallicaUrl: clean(h.gallica_url),
    searchCollapsing: search.collapsing,
    typeAmbiguous: docType.code === "text",
  }
}

/**
 * A catalogue hit → the buffer candidate. The payload carries no type, so
 * docType stays unset (enrichment or the resolver fills it after commit) and
 * the kind is that of a `cb…` notice.
 */
export function candidateFromCatalogueHit(h: CatalogueHit): BufferCandidateInput | null {
  const ark = toFullArk(h.ark)
  if (ark === null) return null
  const year = toYear(h.date)
  return {
    ark,
    title: clean(h.title),
    creator: clean(h.author),
    publisher: clean(h.publisher),
    year,
    yearEnd: toYearEnd(h.date, year),
    dateLabel: clean(h.date),
    arkKind: classifyArkKind({ ark, collectionEntry: false, docType: null }),
    lang: canonicalLang(h.language) ?? undefined,
    source: sourceFromArk(ark),
    catalogueUrl: clean(h.catalogue_url),
    gallicaUrl: clean(h.gallica_url),
  }
}

/**
 * Weights for `mostDistinctiveTerm`'s scoring. A capitalised token outranks any
 * lowercase one; length only breaks ties between tokens of the same class; the
 * weak-proper-noun penalty exactly cancels the capitalisation bonus, demoting
 * "Laboratoires" to compete on length alone.
 */
const TERM_SCORE = {
  capitalised: 3,
  weakProperNounPenalty: 3,
  lengthDivisor: 10,
} as const

/** Shortest token worth probing — below this a term carries no discrimination. */
const MIN_TERM_LENGTH = 3

/**
 * Capitalised words that carry a company or edition name without discriminating
 * between any two of them. They rank as proper nouns on every structural signal
 * yet make terrible search terms, and they lead French institutional names often
 * enough ("Laboratoires Vichy", "Éditions Gallimard") to be worth demoting.
 */
const WEAK_PROPER_NOUNS = new Set([
  "laboratoire",
  "laboratoires",
  "etablissement",
  "etablissements",
  "societe",
  "editions",
  "edition",
  "maison",
  "compagnie",
  "institut",
  "collection",
  "recueil",
])

/** Casefold for comparison: lowercase, accents removed. */
function fold(term: string): string {
  return term
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
}

/**
 * The most distinctive-looking term of a free-text query, or null when the query
 * is already a single term (nothing to narrow to).
 *
 * A librarian types "Maybelline maquillage". The catalogue index holds
 * bibliographic notices only — no full text — and its CQL `all` operator demands
 * that EVERY word appear in one notice, so a single descriptive word zeroes an
 * otherwise rich result set: "Maybelline" matches 111 records, "Maybelline
 * maquillage" matches none. What a notice actually contains is proper nouns —
 * brands, people, titles — so capitalisation is the signal we rank on, with
 * length as the tiebreak and a demotion for the generic name-leaders above.
 * Elided articles ("L'Oréal") are stripped so the scored token is the name.
 *
 * This is a HEURISTIC and it will sometimes pick the wrong proper noun — the
 * real signal is corpus rarity, which we cannot compute here. That is tolerable
 * because of how the result is used: the probe exists to produce a count that
 * CONTRADICTS a zero, and `zeroResultDiagnostic` deliberately does not tell the
 * agent to re-run on this term. The agent knows the librarian's subject; we
 * only know the string.
 */
export function mostDistinctiveTerm(query: string): string | null {
  const tokens = query.split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return null

  let bestTerm: string | null = null
  let bestScore = -1
  for (const raw of tokens) {
    const term = raw
      .replace(/^\p{L}['’]/u, "") // elision: "L'Oréal" → "Oréal", "d'Alembert" → "Alembert"
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") // strip surrounding punctuation
    if (term.length < MIN_TERM_LENGTH) continue
    const capitalised = term[0] !== term[0].toLowerCase()
    const score =
      (capitalised ? TERM_SCORE.capitalised : 0) +
      term.length / TERM_SCORE.lengthDivisor -
      (WEAK_PROPER_NOUNS.has(fold(term)) ? TERM_SCORE.weakProperNounPenalty : 0)
    if (score > bestScore) {
      bestScore = score
      bestTerm = term
    }
  }
  return bestTerm !== null && bestTerm !== query ? bestTerm : null
}

/**
 * How many records one term matches, without staging anything.
 *
 * Used solely to contradict a zero result, so its own failure is NOT the
 * caller's failure: log and return null, and let the diagnostic fall back to
 * prose. (The deliberate exception to the log-AND-propagate rule in
 * CLAUDE_ERROR_PATTERNS §5 — raising here would turn a successful search that
 * happened to match nothing into a failed one.)
 *
 * DELIBERATE DEVIATION from playbook/mcp-client.md ("Don't add new BnF egress
 * here"). The rule exists to stop uncoordinated traffic contending with the
 * broker for BnF's shared quota; the measured cost here is the other way round.
 * Prod ran 313 catalogue searches in 90 days, 43% of them zero — so this adds
 * roughly 1.5 one-record calls a day, against a 1000/min budget — and it exists
 * to END the blind reformulation loop a zero currently triggers (twenty-odd
 * wasted searches in the session this was written for). If that trade ever
 * stops holding, delete the probe: `zeroResultDiagnostic` degrades to prose.
 */
async function countMatches(
  mcpEnv: { BNF_MCP_URL: string; BNF_MCP_TOKEN: string },
  source: SearchSource,
  query: string,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  const tool = BNF_SEARCH_TOOL[source]
  try {
    const payload = await callBnfTool<{ pagination: BnfSearchPagination }>(
      mcpEnv.BNF_MCP_URL,
      mcpEnv.BNF_MCP_TOKEN,
      tool,
      { response_format: "json", query, start_record: 1, maximum_records: 1 },
      signal,
    )
    const total = payload.pagination?.total
    if (typeof total !== "number") {
      // Succeeded but shaped wrong — the same contract breach the search branches
      // throw on. Here it only costs the diagnostic, so log it rather than fail
      // the search, but never let it pass as an ordinary "probe unavailable".
      console.warn(`[corpus_search] zero-result probe on ${tool} ("${query}") returned no total`)
      return null
    }
    return total
  } catch (err) {
    console.warn(`[corpus_search] zero-result probe on ${tool} ("${query}") failed:`, err)
    return null
  }
}

/** What the agent is told when a search matched nothing. */
interface ZeroResultDiagnostic {
  meaning: string
  probed_term?: string
  probed_term_total?: number
  next_step: string
}

/**
 * The `zero_result` block for a zero the BnF REFUSED, or null when it did not.
 *
 * Null is the signal to fall through to `zeroResultDiagnostic`'s probe, and the
 * distinction is the whole point: probing a refused query re-runs the SAME
 * unsupported construct, gets another zero, and reports "ce terme ne donne rien
 * non plus" — manufacturing the false absence the probe exists to prevent.
 *
 * Pure so the ordering can be tested without a BnF round-trip.
 */
export function refusalZeroResult(diagnostics: BnfDiagnostic[]): ZeroResultDiagnostic | null {
  if (diagnostics.length === 0) return null

  const reasons = diagnostics
    .map((d) => (d.details ? `${d.message} (${d.details})` : d.message))
    .join(" ; ")

  return {
    meaning:
      "La BnF a REFUSÉ une partie de cette requête — ce zéro signifie « non exprimable " +
      `sur cet index », PAS « rien n'existe » : ${reasons}`,
    next_step:
      "Corrige la requête comme l'indique le diagnostic, ou passe à l'autre source " +
      "(catalogue ↔ gallica). Ne conclus RIEN sur les collections à partir de ce zéro.",
  }
}

/**
 * Explain a zero — never hand one back bare.
 *
 * A bare `total: 0` is the most dangerous value this tool returns. The agent
 * reads it as "the BnF holds nothing on this" and tells a BnF librarian so; in
 * the incident this guards against, the agent reported two brands as having
 * "aucune trace au catalogue ni sur Gallica" while 68 documents from those very
 * searches sat committed in the user's corpus. So we state what a zero means,
 * and — when the query has something narrower to fall back to — we spend one
 * 1-record probe to hand back the count that contradicts it. Prose alone did not
 * prove enough: a NUMBER is what stops the model concluding absence.
 *
 * The probe only fires on the pattern that is actually broken (a multi-term
 * query that matched nothing), and it replaces the blind reformulation loop the
 * agent otherwise runs — around twenty wasted searches in the reference session
 * — so it costs the shared BnF rate budget less than the behaviour it removes.
 */
async function zeroResultDiagnostic(
  mcpEnv: { BNF_MCP_URL: string; BNF_MCP_TOKEN: string },
  source: SearchSource,
  query: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ZeroResultDiagnostic> {
  const meaning =
    source === DOCUMENT_SOURCE.CATALOGUE
      ? "`total: 0` ne veut PAS dire que ces documents sont absents des collections de la BnF. " +
        "Le catalogue indexe des NOTICES bibliographiques (titre, auteur, éditeur, sujet), sans plein texte, " +
        "et TOUS les mots de `query` doivent figurer dans une même notice : un seul mot descriptif " +
        "(« cosmétiques », « histoire », « produits ») suffit à ramener un résultat riche à zéro."
      : "`total: 0` ne veut PAS dire que ces documents sont absents de Gallica. " +
        "Gallica indexe le plein texte OCR, et TOUS les mots de `query` doivent apparaître dans un même document."

  const narrowed = query ? mostDistinctiveTerm(query) : null
  if (narrowed === null) {
    return {
      meaning,
      next_step:
        "Essaie l'AUTRE source (catalogue ↔ gallica) et les critères `creator` / `title`, " +
        "qui ciblent un champ précis au lieu du plein texte, AVANT toute conclusion. " +
        "Ne dis jamais au bibliothécaire qu'un sujet est absent sur la foi d'une seule requête.",
    }
  }

  const probed = await countMatches(mcpEnv, source, narrowed, signal)
  const narrowAdvice =
    "Relance avec le SEUL terme distinctif de ton sujet — la marque, la personne ou le titre, " +
    "celui que porterait la notice — puis affine avec `date` / `language` / `doc_type`. " +
    "N'ajoute jamais de mot descriptif à `query` : chaque mot en plus retire des résultats."

  if (probed === null) {
    return { meaning, probed_term: narrowed, next_step: narrowAdvice }
  }
  return {
    meaning,
    probed_term: narrowed,
    probed_term_total: probed,
    next_step:
      probed > 0
        ? `Vérification : « ${narrowed} », tiré de ta requête, donne à lui seul ${probed} résultat(s) dans ce ` +
          "même index. C'est donc ta REQUÊTE qui était trop étroite, pas le fonds qui est vide. " +
          narrowAdvice
        : `Vérification : « ${narrowed} », tiré de ta requête, ne donne rien non plus ici — mais ce terme n'est ` +
          "peut-être pas le bon. " +
          narrowAdvice +
          " Essaie aussi l'AUTRE source (catalogue ↔ gallica), `creator` / `title`, et les variantes du nom, " +
          "avant de conclure quoi que ce soit.",
  }
}

/** The two BnF indexes corpus_search queries. */
const SEARCH_SOURCES = [DOCUMENT_SOURCE.GALLICA, DOCUMENT_SOURCE.CATALOGUE] as const
const searchSourceEnum = z.enum(SEARCH_SOURCES)
const gallicaSortEnum = z.enum(GALLICA_SORT_KEYS)
/** A 4-digit year, the form bib.publicationdate takes. */
const yearStringSchema = z.string().trim().regex(/^\d{4}$/, "année sur 4 chiffres, ex. \"1960\"")
type SearchSource = z.infer<typeof searchSourceEnum>

/** corpus_search's refusal of parameters it cannot honour: the fixes travel
 *  in `problems`, and `error` says so in one line the model reads first. */
function invalidSearchParams(problems: string[]): ToolRefusal<typeof INVALID_PARAMS_REFUSAL> & { problems: string[] } {
  return {
    ...toolRefusal(INVALID_PARAMS_REFUSAL, `Paramètres de recherche refusés, rien n'a été envoyé : ${problems.join(" ; ")}`),
    problems,
  }
}

/** The criteria part of a corpus_search input — what the pure helpers below read. */
export type CorpusSearchCriteria = {
  source: SearchSource
  cql?: string
  query?: string
  title?: string
  creator?: string
  /** Alias of `creator` — the incident agent's spelling (catalogue vocabulary). */
  author?: string
  subject?: string
  date?: string
  shelfmark?: string
  /** Catalogue only — bib.publicationdate range. */
  date_from?: string
  date_to?: string
  /** Gallica only. */
  doc_type?: string
  collapsing?: boolean
  sort?: (typeof GALLICA_SORT_KEYS)[number]
  language?: string
}

/** Every criterion that satisfies "give at least one", in the order the message lists them. */
const SEARCH_CRITERIA = [
  "cql",
  "query",
  "title",
  "creator",
  "author",
  "subject",
  "date",
  "shelfmark",
  "date_from",
  "date_to",
] as const

/** The simple criteria a raw `cql` replaces — sending both would AND two queries. */
const CQL_EXCLUSIVE = [
  "query",
  "title",
  "creator",
  "author",
  "subject",
  "shelfmark",
  "date",
  "date_from",
  "date_to",
  "doc_type",
  "language",
] as const

/** True when an optional criterion was actually given. */
function given(value: string | boolean | undefined): boolean {
  return value !== undefined && value !== ""
}

/**
 * Parameters the chosen source (or a raw `cql`) cannot honour, as French
 * problems the agent can fix — empty when the combination is valid. Found bug:
 * these used to be DROPPED silently (doc_type on the catalogue, every simple
 * criterion next to `cql`, and mcp-bnf ignores `sort` when `cql` is given), so
 * the agent believed a filter applied that never reached the BnF. `collapsing`
 * is compatible with `cql`: it is a request parameter, not a CQL clause.
 */
export function incompatibleSearchParams(input: CorpusSearchCriteria): string[] {
  const problems: string[] = []
  if (input.source === DOCUMENT_SOURCE.CATALOGUE) {
    const gallicaOnly = (["doc_type", "collapsing", "sort"] as const).filter((k) => given(input[k]))
    if (gallicaOnly.length > 0) {
      problems.push(
        `${gallicaOnly.map((k) => `\`${k}\``).join(", ")} n'existe(nt) que pour Gallica : retire-le(s) ` +
          "pour le catalogue, ou passe `source: \"gallica\"`.",
      )
    }
  } else if (given(input.date_from) || given(input.date_to)) {
    const from = input.date_from ?? "1850"
    const to = input.date_to ?? "1860"
    problems.push(
      "`date_from` / `date_to` n'existent que pour le catalogue. Sur Gallica, exprime l'intervalle en CQL : " +
        `\`cql: dc.date >= "${from}" and dc.date <= "${to}"\` (avec tes autres critères dans le même CQL).`,
    )
  }
  if (given(input.cql)) {
    const mixed = CQL_EXCLUSIVE.filter((k) => given(input[k]))
    if (mixed.length > 0) {
      problems.push(
        `\`cql\` remplace les critères simples, qui seraient ignorés : ${mixed.map((k) => `\`${k}\``).join(", ")}. ` +
          "Intègre ces critères dans le CQL, ou retire `cql`.",
      )
    }
    if (given(input.sort)) {
      problems.push(
        `\`sort\` est ignoré quand \`cql\` est donné : ajoute \`sortBy ${input.sort}\` au CQL ` +
          "(par exemple `sortBy dc.date/sort.ascending`).",
      )
    }
  }
  return problems
}

/**
 * Problems with the criteria themselves — none given, or `creator` and its alias
 * `author` both given. Returned in French for the agent; an empty list means
 * the input is usable. Pure, so the incident's "subject stripped → no criterion
 * → retry storm" (root cause 5) is pinned by a unit test.
 */
export function searchCriterionProblems(input: CorpusSearchCriteria): string[] {
  const problems: string[] = []
  if (!SEARCH_CRITERIA.some((k) => input[k] !== undefined && input[k] !== "")) {
    problems.push(
      `Fournissez au moins un critère de recherche : ${SEARCH_CRITERIA.join(", ")}.`,
    )
  }
  if (input.creator !== undefined && input.author !== undefined) {
    problems.push("`author` est un alias de `creator` : donne l'un ou l'autre, pas les deux.")
  }
  return problems
}

/**
 * The page size to request from the chosen source: the agent's value, checked
 * against that source's ceiling, or the source's default. Never clamped
 * silently — a value above the ceiling is a problem the agent can fix.
 */
export function resolveSearchPageSize(
  source: SearchSource,
  requested: number | undefined,
): { ok: true; pageSize: number } | { ok: false; problems: string[] } {
  const max = BUFFER_SEARCH_MAX_PAGE_SIZE_BY_SOURCE[source]
  if (requested === undefined) return { ok: true, pageSize: BUFFER_SEARCH_DEFAULT_PAGE_SIZE_BY_SOURCE[source] }
  if (requested > max) {
    return { ok: false, problems: [`${source} : ${max} résultats maximum par page (demandé : ${requested}).`] }
  }
  return { ok: true, pageSize: requested }
}

/**
 * The mcp-bnf `tools/call` arguments for the chosen source. The catalogue names
 * the author index `author` (bib.author) where Gallica says `creator`
 * (dc.creator); `subject` exists on both (bib.subject / dc.subject). `cql` is
 * exclusive: mixing it with the simple criteria would AND two queries the
 * librarian never asked to combine. Only provided fields are sent.
 */
export function buildSearchArgs(
  input: CorpusSearchCriteria & { start_record?: number },
  pageSize: number,
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    response_format: "json",
    start_record: input.start_record ?? 1,
    maximum_records: pageSize,
  }
  // `collapsing` is a Gallica request parameter, honoured with or without cql.
  if (input.source === DOCUMENT_SOURCE.GALLICA && input.collapsing !== undefined) args.collapsing = input.collapsing
  if (input.cql) {
    args.cql = input.cql
    return args
  }
  if (input.query) args.query = input.query
  if (input.title) args.title = input.title
  if (input.subject) args.subject = input.subject
  if (input.shelfmark) args.shelfmark = input.shelfmark
  if (input.date) args.date = input.date
  if (input.language) args.language = input.language
  const person = input.creator ?? input.author
  if (input.source === DOCUMENT_SOURCE.GALLICA) {
    if (person) args.creator = person
    if (input.doc_type) args.doc_type = input.doc_type
    if (input.sort) args.sort = input.sort
  } else {
    if (person) args.author = person
    if (input.date_from) args.date_from = input.date_from
    if (input.date_to) args.date_to = input.date_to
  }
  return args
}

export const corpusSearchTool = defineTool<
  z.ZodObject<{
    source: typeof searchSourceEnum
    cql: z.ZodOptional<z.ZodString>
    query: z.ZodOptional<z.ZodString>
    title: z.ZodOptional<z.ZodString>
    creator: z.ZodOptional<z.ZodString>
    author: z.ZodOptional<z.ZodString>
    subject: z.ZodOptional<z.ZodString>
    date: z.ZodOptional<z.ZodString>
    shelfmark: z.ZodOptional<z.ZodString>
    date_from: z.ZodOptional<typeof yearStringSchema>
    date_to: z.ZodOptional<typeof yearStringSchema>
    doc_type: z.ZodOptional<z.ZodString>
    collapsing: z.ZodOptional<z.ZodBoolean>
    sort: z.ZodOptional<typeof gallicaSortEnum>
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
    "list into the conversation. COST: raw bnf__bnf_search_* calls cost the same BnF " +
    "quota but stage nothing; re-adding their ARKs with buffer_add costs one more BnF " +
    "lookup PER ARK to recover the metadata. Pick `source`: \"gallica\" for digitised full-text " +
    "documents, \"catalogue\" for bibliographic records. Give at least one of " +
    "query / title / creator / subject / date / shelfmark (catalogue: date_from / date_to). " +
    "A parameter the chosen source cannot honour is REFUSED (`refused: \"invalid_params\"`) with " +
    "the fix — never silently dropped. It returns a COMPACT summary — total available, " +
    "how many were added to the buffer, the buffer size, and a small sample — NOT " +
    "the full result list; inspect the staged candidates with buffer_stats / " +
    "buffer_list. To gather more, call again with `start_record` advanced by the " +
    "page size (use the returned `next_start_record`) until `has_more` is false. " +
    "Both indexes require EVERY word of `query` to occur in one record, so extra " +
    "descriptive words NARROW rather than broaden: query the brand / person / title " +
    "alone and restrict with date / language / doc_type. A `total` of 0 means " +
    '"nothing under these terms in this index" — never that the BnF holds nothing; ' +
    "when it happens, read the returned `zero_result` block and follow its next_step. " +
    "THE OPPOSITE PROBLEM IS THE COMMON ONE. A Gallica topic search usually returns " +
    "thousands of hits that are mostly PERIODICAL COLLECTIONS — one record standing " +
    "for a title's entire run, matching because the terms appear somewhere across " +
    "decades of issues. That is why a perfume query surfaces L'Est républicain (1889). " +
    "Narrowing the words will not fix it, and neither will `date`: a run covering " +
    "1861-1946 satisfies any year inside it. Only `doc_type` separates the two lanes. " +
    'Want readable documents? doc_type: "monographie" (measured: 13 of 20 hits were ' +
    "collections, 0 of 20 after). PRESS: for the press, search " +
    '`doc_type: "fascicule"` with `collapsing: false`: hits are then individual ISSUES ' +
    "(kind periodical_issue) with their date and title, ready to filter — never " +
    "enumerate issues with bnf__bnf_get_periodical_issues + buffer_add when a search " +
    "can stage them with their metadata. With the default `collapsing: true` each " +
    "press title is ONE collection record (cb…, kind periodical_collection): a TITLE, " +
    "not a document you found. " +
    "For a named person use `creator`, not `query`: free text gave 1131 hits with none " +
    "on target where the creator index gave 23 that were all correct. " +
    "The result says what became of every hit — `added`, `alreadyInCorpus`, " +
    "`previouslyDiscarded`, `refreshed`, and an `explanation` whenever `added` is below " +
    "`found` (read it: `alreadyInCorpus` is not a malfunction) — plus `kinds` (record " +
    "kinds in this page) and `type_ambiguous` when Gallica could not tell press from " +
    "books. Curate with buffer_remove_by_filter, then buffer_commit to add them to the corpus.",
  inputSchema: z.strictObject({
    source: searchSourceEnum.describe(
      'Which BnF index: "gallica" (digitised full text) or "catalogue" (bibliographic).',
    ),
    cql: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Raw CQL, for what the simple criteria cannot express: proximity " +
          '(text all "a" prox/unit=word/distance=3 "b"), date ranges, or/not, ' +
          'grouping, a shelfmark (bib.cote adj "RES P-YF-3"). Overrides the other ' +
          "criteria when given. Validated before it is sent: an unsupported " +
          "construct comes back as a list of problems to fix, never as a silent zero.",
      ),
    query: z.string().trim().min(1).optional().describe("Free-text search terms."),
    title: z.string().trim().min(1).optional().describe("Match on title."),
    creator: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Match on author/creator (mapped to author for the catalogue)."),
    author: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Alias of creator (the catalogue's name for it). Give one or the other, not both."),
    subject: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Subject heading (Rameau / dc.subject): bib.subject on the catalogue, dc.subject on " +
          "Gallica. The catalogue's subject index is far more selective than `query`.",
      ),
    shelfmark: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Shelfmark (cote): bib.cote on the catalogue, dc.source on Gallica, e.g. "8-LC2-151".'),
    date_from: yearStringSchema
      .optional()
      .describe(
        'Catalogue only — publication year lower bound, inclusive, e.g. "1960" (bib.publicationdate). ' +
          "On Gallica, write the range in `cql` instead.",
      ),
    date_to: yearStringSchema
      .optional()
      .describe('Catalogue only — publication year upper bound, inclusive, e.g. "1990".'),
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
        // From GALLICA_SEARCHABLE_DOC_TYPE, NOT the response map: the values Gallica
        // labels records with are a superset of the ones it accepts as a filter, and
        // offering a dead one (typeAffiche, son, video) returns 0 — which the agent
        // reads as absence.
        `Gallica only — one of: ${GALLICA_SEARCHABLE_DOC_TYPE.join(", ")}. ` +
          "Refused for the catalogue (its payload carries no type). " +
          "This is the strongest precision lever Gallica has: it splits located " +
          'documents ("monographie" and the other item types) from periodical ' +
          'COLLECTION records ("fascicule"), which is where nearly all apparent ' +
          "volume — and nearly all noise — comes from. Reach for it before you start " +
          "rewording the query.",
      ),
    collapsing: z
      .boolean()
      .optional()
      .describe(
        "Gallica only. Default true: volumes/issues of one periodical are grouped into ONE " +
          "collection record (cb…). Set false to get the INDIVIDUAL ISSUES (bpt6k…) — required " +
          "for any press corpus (articles of a given year, coverage of an event): with true you " +
          "stage periodical TITLES, not the issues that carry the text. The reported total moves " +
          "a lot between modes; quote it with the mode.",
      ),
    sort: gallicaSortEnum
      .optional()
      .describe("Gallica only — result order. Not with `cql` (write `sortBy …` in the CQL instead)."),
    language: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('3-letter BnF language code, e.g. "fre", "lat", "ger".'),
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
      .max(BUFFER_SEARCH_MAX_PAGE_SIZE_BY_SOURCE.catalogue)
      .optional()
      .describe(
        `Page size: gallica ≤ ${BUFFER_SEARCH_MAX_PAGE_SIZE_BY_SOURCE.gallica}, catalogue ≤ ` +
          `${BUFFER_SEARCH_MAX_PAGE_SIZE_BY_SOURCE.catalogue}; default ` +
          `${BUFFER_SEARCH_DEFAULT_PAGE_SIZE_BY_SOURCE.gallica} / ` +
          `${BUFFER_SEARCH_DEFAULT_PAGE_SIZE_BY_SOURCE.catalogue}. Use LARGE catalogue pages: ` +
          "each call costs BnF quota, and a 3 000-record sweep is 3 calls at 1000, not 60 at 50.",
      ),
  }),
  handler: async (input, ctx) => {
    // Staging writes the project's buffer: authorise before anything else,
    // BnF egress included.
    const gate = await authorizeProjectTool(ctx, BufferPolicy, "mutate")
    if (!gate.ok) return gate.result
    const projectId = gate.project.id

    // Criteria and page size are checked here, not in the Zod schema, so a
    // failure is a clean tool result the agent can react to — never a hard
    // validation throw, never a silent clamp (incident 2026-09-30, root causes
    // 3 and 5).
    const criterionProblems = searchCriterionProblems(input)
    if (criterionProblems.length > 0) return invalidSearchParams(criterionProblems)
    const incompatible = incompatibleSearchParams(input)
    if (incompatible.length > 0) return invalidSearchParams(incompatible)
    const page = resolveSearchPageSize(input.source, input.maximum_records)
    if (!page.ok) return invalidSearchParams(page.problems)

    let mcpEnv: { BNF_MCP_URL: string; BNF_MCP_TOKEN: string }
    try {
      mcpEnv = requireMcpEnv()
    } catch (err) {
      console.error("[corpus_search] BnF MCP env not configured:", err)
      return toolFailure("La recherche BnF est indisponible (le MCP BnF n'est pas configuré pour cette session).")
    }

    const args = buildSearchArgs(input, page.pageSize)

    let candidates: BufferCandidateInput[]
    let pagination: BnfSearchPagination
    // Provenance: what was actually run, so the librarian can see and correct it.
    let executedCql: string | undefined
    let endpoint: string | undefined
    let collapsing: boolean | undefined
    let diagnostics: BnfDiagnostic[] = []
    let typeAmbiguous = 0
    // Every hit the BnF returned for this page, before identifier mapping.
    let hitCount = 0
    try {
      if (input.source === DOCUMENT_SOURCE.GALLICA) {
        const payload = await callBnfTool<GallicaPayload>(
          mcpEnv.BNF_MCP_URL,
          mcpEnv.BNF_MCP_TOKEN,
          BNF_SEARCH_TOOL.gallica,
          args,
          ctx.signal,
        )
        pagination = payload.pagination
        executedCql = payload.executed_cql
        endpoint = payload.endpoint
        collapsing = payload.collapsing
        diagnostics = payload.diagnostics ?? []
        // `callBnfTool` has already rejected the `{success:false}` envelope, so a
        // payload reaching here and still missing its result list is a contract
        // breach, not an empty search — say so rather than staging nothing.
        if (!Array.isArray(payload.data?.results)) {
          throw new BnfMcpError(`${BNF_SEARCH_TOOL.gallica}: payload carried no results array`)
        }
        // The search's own doc_type filter classifies every hit better than
        // the hit's label (Gallica labels press issues and monographs alike
        // `text`). The collapsing mode is recorded as provenance only.
        const search = {
          docTypeFilter: gallicaSearchDocType(input.doc_type, executedCql ?? input.cql),
          collapsing: collapsing ?? input.collapsing ?? GALLICA_COLLAPSING_DEFAULT,
        }
        hitCount = payload.data.results.length
        const mapped = payload.data.results.flatMap((h) => {
          const c = candidateFromGallicaHit(h, search)
          return c === null ? [] : [c]
        })
        typeAmbiguous = mapped.filter((c) => c.typeAmbiguous).length
        candidates = mapped.map(({ typeAmbiguous: _ambiguous, ...c }) => c)
      } else {
        const payload = await callBnfTool<CataloguePayload>(
          mcpEnv.BNF_MCP_URL,
          mcpEnv.BNF_MCP_TOKEN,
          BNF_SEARCH_TOOL.catalogue,
          args,
          ctx.signal,
        )
        pagination = payload.pagination
        executedCql = payload.executed_cql
        endpoint = payload.endpoint
        collapsing = payload.collapsing
        diagnostics = payload.diagnostics ?? []
        // See the gallica branch: a successful payload without its record list
        // is a contract breach, not an empty search.
        if (!Array.isArray(payload.data?.records)) {
          throw new BnfMcpError(`${BNF_SEARCH_TOOL.catalogue}: payload carried no records array`)
        }
        hitCount = payload.data.records.length
        candidates = payload.data.records.flatMap((h) => {
          const c = candidateFromCatalogueHit(h)
          return c === null ? [] : [c]
        })
      }
    } catch (err) {
      // Coerce the transport/tool failure into a structured tool result the
      // agent can react to (CLAUDE_ERROR_PATTERNS §15) — never throw out.
      //
      // Every return below is the one failure shape of failure.ts: its
      // `success: false` is what `toolCallErrored` keys on, so an outage turns
      // the chip and the health lane red instead of persisting as "ok".
      // A refused query is not a failure: nothing broke, the CQL was simply not
      // expressible on that index and the MCP declined to send it. Hand the
      // agent the specific fixes so it can correct itself inside the turn —
      // flattening this into "la recherche a échoué" would teach it nothing.
      if (err instanceof BnfMcpQueryRefusedError) {
        return {
          ...toolRefusal(
            QUERY_NOT_EXPRESSIBLE_REFUSAL,
            "Cette requête n'est pas exprimable sur cet index : elle n'a PAS été envoyée. " +
              "Ce n'est pas un résultat vide — corrige la requête et relance.",
          ),
          problems: err.problems,
        }
      }
      // The app's own limiter shed the call before it left the process
      // (incident 2026-09-30): the quota is shared by every agent of the
      // application, so the agent is told to slow down, not to retry harder.
      if (err instanceof BnfMcpQuotaSaturatedError) {
        return quotaSaturatedResult({ api: err.api, waitedMs: err.waitedMs })
      }
      const message = err instanceof BnfMcpError ? err.message : String(err)
      return toolFailure(`La recherche BnF a échoué : ${message}`)
    }

    const registered = await BufferService.registerCandidates({
      projectId,
      sessionId: ctx.appSessionId,
      originTool: AGENT_TOOLS.corpusSearch,
      // The EXECUTED CQL, not the agent's input: it is what the librarian needs
      // to judge a result set, and the only form that can be re-run verbatim.
      // Falls back to the raw criteria when talking to a pre-0.4.0 MCP.
      restageDiscarded: false,
      originQuery:
        executedCql ??
        input.cql ??
        input.query ??
        input.title ??
        input.creator ??
        input.author ??
        input.subject ??
        input.date ??
        null,
      candidates,
    })

    // Every hit the BnF returned is accounted for: those whose identifier is
    // not a document ARK were dropped before registration and count with the
    // registration's own skips, so `found` is the true hit count and the
    // explanation covers every hit that did not become a candidate.
    const unaddressable = hitCount - candidates.length
    const accounted: BufferRegisterResult = { ...registered, skipped: registered.skipped + unaddressable }

    // A spawn_research child reports what IT staged (never a project-wide delta).
    if (ctx.stagingTally) ctx.stagingTally.added += registered.added
    const buffered = await emitBuffer(ctx, projectId, BUFFER_EVENT_KIND.ADDED, registered.added)

    // Never return a bare zero — see zeroResultDiagnostic.
    //
    // ORDER MATTERS. There are two different zeros and only one of them is
    // worth probing:
    //
    //   1. The BnF REFUSED part of the query and said so in `diagnostics`
    //      (mcp-bnf >= 0.4.0 surfaces them). The result set is empty because
    //      the query was not expressible, not because the fonds is. Probing a
    //      narrower term here would re-run the SAME unsupported construct, get
    //      another zero, and report "ce terme ne donne rien non plus" —
    //      manufacturing exactly the false absence this guard exists to stop.
    //   2. No diagnostic: the query ran and genuinely matched nothing, usually
    //      because `all` requires every word in one record. That is what the
    //      distinctive-term probe is for.
    const zeroResult =
      pagination.total === 0
        ? (refusalZeroResult(diagnostics) ??
          (await zeroResultDiagnostic(mcpEnv, input.source, input.query, ctx.signal)))
        : null

    return {
      source: input.source,
      ...(executedCql !== undefined ? { executed_cql: executedCql } : {}),
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(collapsing !== undefined ? { collapsing } : {}),
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
      total: pagination.total,
      ...(zeroResult !== null ? { zero_result: zeroResult } : {}),
      found: hitCount,
      ...stagingCounts(hitCount, accounted),
      // Hits dropped because their identifier is not a document ARK (e.g. a
      // periodical COLLECTION entry): enumerate its issues with
      // bnf__bnf_get_periodical_issues, then stage those with buffer_add.
      ...(accounted.skipped > 0 ? { skipped_not_a_document: accounted.skipped } : {}),
      buffered,
      has_more: pagination.has_more,
      ...(pagination.next_start_record !== undefined
        ? { next_start_record: pagination.next_start_record }
        : {}),
      kinds: countKinds(candidates),
      ...(typeAmbiguous > 0
        ? {
            type_ambiguous: typeAmbiguous,
            type_ambiguous_hint:
              `${typeAmbiguous} résultat(s) sont de type « texte » sans précision : relance avec ` +
              '`doc_type: "fascicule"` (presse) ou `"monographie"` (livres) pour les distinguer.',
          }
        : {}),
      sample: candidates.slice(0, CORPUS_SEARCH_SAMPLE_SIZE).map((c) => ({
        ark: c.ark,
        title: c.title ?? null,
        year: c.year ?? null,
        kind: c.arkKind ?? null,
        creator: c.creator ?? null,
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
