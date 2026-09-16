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
import { BnfMcpError, BnfMcpQueryRefusedError } from "@/lib/mcp/errors"
import { parseBnfDate } from "@/lib/mcp/normalize"
import { BNF_SEARCH_TOOL } from "@/lib/mcp/tools"
import { GALLICA_DOC_TYPE, sourceFromArk } from "@/lib/mcp/vocab"
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
  source: "gallica" | "catalogue",
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
  source: "gallica" | "catalogue",
  query: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ZeroResultDiagnostic> {
  const meaning =
    source === "catalogue"
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

const searchSourceEnum = z.enum(["gallica", "catalogue"])

export const corpusSearchTool = defineTool<
  z.ZodObject<{
    source: typeof searchSourceEnum
    cql: z.ZodOptional<z.ZodString>
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
    "collections, 0 of 20 after). Want the press — publicité, comptes rendus, " +
    'réception? Keep the periodical lane, but treat a "fascicule" hit as a TITLE to ' +
    "drill into with bnf__bnf_get_periodical_issues, never as a document you found. " +
    "For a named person use `creator`, not `query`: free text gave 1131 hits with none " +
    "on target where the creator index gave 23 that were all correct. " +
    "Curate with buffer_remove_by_filter, then buffer_commit to add them to the corpus.",
  inputSchema: z.object({
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
        // The nine codes come from GALLICA_DOC_TYPE — restating them here would be a
        // second source of truth that drifts silently when BnF changes its typedoc set.
        `Gallica only — one of: ${Object.keys(GALLICA_DOC_TYPE).join(", ")}. ` +
          "Ignored for the catalogue. " +
          "This is the strongest precision lever Gallica has: it splits located " +
          'documents ("monographie" and the other item types) from periodical ' +
          'COLLECTION records ("fascicule"), which is where nearly all apparent ' +
          "volume — and nearly all noise — comes from. Reach for it before you start " +
          "rewording the query.",
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
    if (!input.cql && !input.query && !input.title && !input.creator && !input.date) {
      return {
        success: false,
        error: "Fournissez au moins un critère de recherche : query, title, creator ou date.",
      }
    }

    let mcpEnv: { BNF_MCP_URL: string; BNF_MCP_TOKEN: string }
    try {
      mcpEnv = requireMcpEnv()
    } catch {
      return {
        success: false,
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
    // `cql` is exclusive: mixing it with the simple criteria would AND two
    // queries the librarian never asked to combine.
    if (input.cql) common.cql = input.cql
    else if (input.query) common.query = input.query
    if (!input.cql) {
      if (input.title) common.title = input.title
      if (input.date) common.date = input.date
      if (input.language) common.language = input.language
    }

    let candidates: BufferCandidateInput[]
    let pagination: BnfSearchPagination
    // Provenance: what was actually run, so the librarian can see and correct it.
    let executedCql: string | undefined
    let endpoint: string | undefined
    let collapsing: boolean | undefined
    let diagnostics: BnfDiagnostic[] = []
    try {
      if (input.source === "gallica") {
        const args = { ...common }
        if (!input.cql) {
          if (input.creator) args.creator = input.creator
          if (input.doc_type) args.doc_type = input.doc_type
        }
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
        candidates = payload.data.results.flatMap((h) => {
          const ark = toFullArk(h.ark)
          if (ark === null) return []
          return [
            {
              ark,
              title: clean(h.title),
              year: toYear(h.date),
              docType: clean(h.doc_type),
              lang: clean(h.language),
              source: sourceFromArk(ark),
              snippet: clean(h.description),
            },
          ]
        })
      } else {
        const args = { ...common }
        if (!input.cql && input.creator) args.author = input.creator
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
        candidates = payload.data.records.flatMap((h) => {
          const ark = toFullArk(h.ark)
          if (ark === null) return []
          return [
            {
              ark,
              title: clean(h.title),
              year: toYear(h.date),
              // The catalogue payload carries no doc_type; leave it for the
              // background resolver to fill in after commit.
              lang: clean(h.language),
              source: sourceFromArk(ark),
            },
          ]
        })
      }
    } catch (err) {
      // Coerce the transport/tool failure into a structured tool result the
      // agent can react to (CLAUDE_ERROR_PATTERNS §15) — never throw out.
      //
      // `success: false` is what marks this as a REAL failure rather than a
      // structured outcome. `toolCallErrored` keys on that flag, so without it
      // the row persists as status "ok": the chip shows ✓ and the health lane
      // stays green through an outage. It is set deliberately here and NOT
      // inferred from the presence of an `error` key, because several handlers
      // return `{ error }` for expected states — rag_* before ingestion,
      // doc_get on an ARK outside the corpus — which must NOT flare the lanes.
      // A refused query is not a failure: nothing broke, the CQL was simply not
      // expressible on that index and the MCP declined to send it. Hand the
      // agent the specific fixes so it can correct itself inside the turn —
      // flattening this into "la recherche a échoué" would teach it nothing.
      if (err instanceof BnfMcpQueryRefusedError) {
        return {
          success: false,
          refused: true,
          error:
            "Cette requête n'est pas exprimable sur cet index : elle n'a PAS été envoyée. " +
            "Ce n'est pas un résultat vide — corrige la requête et relance.",
          problems: err.problems,
        }
      }
      const message = err instanceof BnfMcpError ? err.message : String(err)
      return { success: false, error: `La recherche BnF a échoué : ${message}` }
    }

    const registered = await BufferService.registerCandidates({
      projectId,
      sessionId: ctx.appSessionId,
      originTool: AGENT_TOOLS.corpusSearch,
      // The EXECUTED CQL, not the agent's input: it is what the librarian needs
      // to judge a result set, and the only form that can be re-run verbatim.
      // Falls back to the raw criteria when talking to a pre-0.4.0 MCP.
      originQuery:
        executedCql ?? input.cql ?? input.query ?? input.title ?? input.creator ?? input.date ?? null,
      candidates,
    })

    const buffered = await emitBuffer(ctx, projectId, "added", registered.added)

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
      found: candidates.length,
      added: registered.added,
      refreshed: registered.refreshed,
      // Hits dropped because they are not addressable documents (e.g. a
      // periodical COLLECTION entry): enumerate its issues with
      // bnf__bnf_get_periodical_issues, then stage those with buffer_add.
      ...(registered.skipped > 0 ? { skipped_not_a_document: registered.skipped } : {}),
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
