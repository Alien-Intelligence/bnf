// lib/mcp/rate-limit.ts
// App-side rate limiter for EVERY BnF MCP call this process dispatches.
//
// Why it exists (incident 2026-09-30, ai-memories/tech/incidents/
// 2026-09-30-bnf-catalogue-sru-flood.md): one corpus session fanned out to 7
// spawn_research children and made 2 548 catalogue searches in 2.5 h. Nothing
// on the app → mcp-bnf → platform proxy → BnF path throttled, so BnF answered
// 346 × 429 and 252 × 500 on the catalogue connector. The buckets below are set
// to the interface key's quotas (helm `config.bnfMcpRate`, × 0.95), shared by
// the parent turn, every sub-agent and the app's own corpus_search.
//
// COVERAGE CONTRACT (Decision 17 of the Track E plan). One process-wide set of
// buckets, two enforcement points:
//   (a) `callBnfTool` (lib/mcp/call.ts) — the app-made calls: corpus_search and
//       its zero-result probe.
//   (b) `withBnfRateLimit(registry)` (lib/mcp/rate-limited-registry.ts) — a
//       ToolRegistry decorator wrapping `dispatch`, applied to the parent turn
//       registry (lib/agent/tools/registry-factory.ts) and to every
//       spawn_research child registry (lib/agent/tools/spawn.ts). Every
//       chat-sdk dispatch site calls `.dispatch` on the registry it was handed
//       (verified: dist/server/index.js, dist/claude/index.js,
//       dist/openrouter/index.js), so this throttles the raw `bnf__*` tools
//       the model issues directly, with no SDK change. `onToolStart` cannot do
//       this: it is sync-only and cannot veto.
// Every call acquires the GLOBAL bucket first, then its API bucket, against ONE
// deadline computed when the call is enqueued (BNF_MCP_RATE_MAX_WAIT_MS). A
// call that cannot get its tokens before the deadline is SHED: it never reaches
// BnF and the caller gets a structured "quota saturé" result (never a throw out
// of the tool loop — CLAUDE_ERROR_PATTERNS §15). One acquire per MCP call: a
// retry by the model acquires again, which is what makes 8 agents share 47/min.
//
// NOT COVERED, on purpose:
//   - MCP `tools/list` discovery — it never reaches BnF.
//   - Other mcp-bnf clients sharing the platform connectors (none in prod
//     today besides this app; the token is app-wide).
//   - The upstream HTTP requests an MCP tool makes internally. The limiter
//     counts MCP CALLS weighted by the number of upstream requests a call is
//     known to make (`bnfMcpCallWeight`); mcp-bnf's own SRU cache (1 h) means
//     real upstream traffic is ≤ the counted traffic.
//   - Other replicas. The buckets are in-memory and exact for the ONE replica
//     the chart runs (Decision 19); the chart divides every rate by
//     `replicaCount` so a scale-out stays under quota by construction.
//
// Bucket semantics (copied from broker/src/rate.ts, which is a separate
// package and cannot be imported): FIFO acquire chain, deadline-from-enqueue so
// queue time counts against the caller's budget, a shed acquirer still advances
// the chain, injectable clock and sleep so tests never wait on real time.
import "server-only"

import { requireBnfRateEnv } from "@/lib/env"
import { type BnfMcpToolName } from "./tools"

// ---------------------------------------------------------------------------
// BnF APIs behind mcp-bnf, and which tool hits which
// ---------------------------------------------------------------------------

/** The BnF APIs the interface key is quota'd on, one bucket each. */
export const BNF_API = {
  /** Catalogue général SRU (bib.* indexes). */
  CATALOGUE: "catalogue",
  /** Gallica SRU (dc.* indexes, full-text). */
  GALLICA_SRU: "gallica_sru",
  /** Gallica IIIF / document services (manifest, pages, ALTO, images). */
  IIIF: "iiif",
  /** Gallica "date-périodique" issue listing. */
  ISSUES: "issues",
  /** data.bnf.fr SPARQL ("graphe"). */
  GRAPHE: "graphe",
} as const
export type BnfApi = (typeof BNF_API)[keyof typeof BNF_API]

/** The bucket a refusal names: one of the APIs, or the global ceiling. */
export type BnfRateBucketName = BnfApi | "global"

/**
 * Unprefixed mcp-bnf tool name → the BnF API it calls (from the clients each
 * tool module instantiates in MCPs/mcp-bnf/src/tools/*). `satisfies` over the
 * tool-name union makes a tool listed in BNF_MCP_TOOLS without a bucket a type
 * error; the test pins the table itself.
 */
export const BNF_MCP_TOOL_API = {
  bnf_search_catalogue: BNF_API.CATALOGUE,
  bnf_get_catalogue_record: BNF_API.CATALOGUE,
  bnf_search_gallica: BNF_API.GALLICA_SRU,
  bnf_get_search_facets: BNF_API.GALLICA_SRU,
  bnf_get_manifest: BNF_API.IIIF,
  bnf_get_image_info: BNF_API.IIIF,
  bnf_get_image_url: BNF_API.IIIF,
  bnf_get_page_ocr_boxes: BNF_API.IIIF,
  bnf_get_document_info: BNF_API.IIIF,
  bnf_get_document_pages: BNF_API.IIIF,
  bnf_get_document_toc: BNF_API.IIIF,
  bnf_get_page_text: BNF_API.IIIF,
  bnf_get_document_text: BNF_API.IIIF,
  bnf_get_periodical_issues: BNF_API.ISSUES,
  bnf_sparql_query: BNF_API.GRAPHE,
  bnf_find_person: BNF_API.GRAPHE,
  bnf_find_work: BNF_API.GRAPHE,
  bnf_resolve_entity: BNF_API.GRAPHE,
} as const satisfies Record<BnfMcpToolName, BnfApi>

function apiForTool(tool: string): BnfApi | null {
  return Object.prototype.hasOwnProperty.call(BNF_MCP_TOOL_API, tool)
    ? BNF_MCP_TOOL_API[tool as BnfMcpToolName]
    : null
}

// ---------------------------------------------------------------------------
// Call weights — upstream requests per MCP call
// ---------------------------------------------------------------------------

/** `bnf_get_document_text` reads one page per `max_pages`; mcp-bnf defaults to 10
 *  and caps at 200 (composite/get_document_text.py). */
const DOCUMENT_TEXT_DEFAULT_PAGES = 10
const DOCUMENT_TEXT_MAX_PAGES = 200
/** `bnf_find_person` runs three SPARQL queries (person, count, sample —
 *  semantic/find_person.py:159,224,268). */
const FIND_PERSON_WEIGHT = 3
/** `bnf_find_work` runs two (work, manifestations — semantic/find_work.py:163,260). */
const FIND_WORK_WEIGHT = 2

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * How many upstream BnF requests one MCP call stands for. 1 for every tool
 * except the ones known to fan out: a full-text read costs one manifest plus
 * one ALTO per page, and the semantic helpers chain several SPARQL queries.
 */
export function bnfMcpCallWeight(tool: string, input: Record<string, unknown>): number {
  switch (tool) {
    case "bnf_get_document_text": {
      const raw = input.max_pages
      const pages =
        typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DOCUMENT_TEXT_DEFAULT_PAGES
      return 1 + clamp(pages, 1, DOCUMENT_TEXT_MAX_PAGES)
    }
    case "bnf_find_person":
      return FIND_PERSON_WEIGHT
    case "bnf_find_work":
      return FIND_WORK_WEIGHT
    default:
      return 1
  }
}

// ---------------------------------------------------------------------------
// Token bucket
// ---------------------------------------------------------------------------

/** Burst headroom per bucket: a tenth of the minute rate (≤ 6 s of quota), ≥ 1. */
export function bucketBurst(rpm: number): number {
  return Math.max(1, Math.floor(rpm / 10))
}

/** Default sleep: a real timer that ends early when `signal` aborts. */
function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Thrown by `TokenBucket.acquire()` when the tokens cannot be granted before
 * the caller's deadline. The limiter maps it to a structured refusal; it never
 * leaves `acquireBnfMcp`.
 */
export class RateWaitTimeoutError extends Error {
  constructor(public readonly neededMs: number) {
    super(`rate budget exhausted: capacity needs ~${Math.round(neededMs)}ms, over the deadline`)
    this.name = "RateWaitTimeoutError"
  }
}

export interface TokenBucketOptions {
  /** Steady-state requests per minute. */
  rpm: number
  /** Maximum tokens that can accumulate (burst headroom). */
  burst: number
  /** Injectable monotonic clock (ms). Defaults to `performance.now()`. */
  now?: () => number
  /** Injectable sleep; receives the abort signal so a cancelled turn stops waiting. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export class TokenBucket {
  private readonly rps: number
  private readonly burst: number
  private tokens: number
  private lastRefill: number
  /** FIFO chain so acquirers take tokens in arrival order, not racing. */
  private chain: Promise<void> = Promise.resolve()
  private readonly now: () => number
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>

  constructor(opts: TokenBucketOptions) {
    if (!Number.isFinite(opts.rpm) || opts.rpm <= 0) {
      throw new Error(`TokenBucket: rpm must be > 0, got ${opts.rpm}`)
    }
    if (!Number.isFinite(opts.burst) || opts.burst < 1) {
      throw new Error(`TokenBucket: burst must be >= 1, got ${opts.burst}`)
    }
    this.rps = opts.rpm / 60
    this.burst = opts.burst
    this.tokens = opts.burst
    this.now = opts.now ?? (() => performance.now())
    this.sleepFn = opts.sleep ?? realSleep
    this.lastRefill = this.now()
  }

  /**
   * Take `weight` tokens, waiting no later than the ABSOLUTE `deadlineMs` (on
   * this bucket's clock). The deadline is the caller's, computed before the
   * call joins the FIFO chain, so time spent queued behind other acquirers
   * counts against the same budget as time spent waiting for a refill. A shed
   * or aborted acquirer still advances the chain, so a saturated bucket drains
   * a queued burst as fast refusals rather than a pile of serial sleeps.
   *
   * A weight above `burst` is granted once the bucket has refilled to `burst`,
   * and the balance then goes negative (overdraw): a heavy call pays its real
   * cost through the callers behind it instead of deadlocking on a token count
   * the bucket can never hold.
   */
  acquire(weight: number, deadlineMs: number, signal?: AbortSignal): Promise<void> {
    const next = this.chain.then(() => this.consume(weight, deadlineMs, signal))
    this.chain = next.catch(() => undefined) // never poison the queue
    return next
  }

  private async consume(weight: number, deadline: number, signal?: AbortSignal): Promise<void> {
    const need = Math.min(weight, this.burst)
    for (;;) {
      if (signal?.aborted) throw signal.reason
      // Re-derived fresh on every pass (never accumulated), so a caller whose
      // budget expired while queued sheds the moment that is discovered.
      const remaining = deadline - this.now()
      this.refill()
      if (this.tokens >= need) {
        this.tokens -= weight
        return
      }
      const deficit = need - this.tokens
      const waitMs = (deficit / this.rps) * 1000
      if (waitMs > remaining) throw new RateWaitTimeoutError(waitMs)
      await this.sleepFn(waitMs, signal)
    }
  }

  private refill(): void {
    const now = this.now()
    const elapsedSec = (now - this.lastRefill) / 1000
    if (elapsedSec <= 0) return
    this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.rps)
    this.lastRefill = now
  }
}

// ---------------------------------------------------------------------------
// The process-wide limiter
// ---------------------------------------------------------------------------

export interface BnfRateLimiterConfig {
  globalRpm: number
  catalogueRpm: number
  gallicaSruRpm: number
  iiifRpm: number
  issuesRpm: number
  grapheRpm: number
  /** Bounded wait from enqueue before a call is shed. */
  maxWaitMs: number
  /** Test seams — production uses the real clock and timers. */
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

class BnfRateLimiter {
  readonly global: TokenBucket
  readonly byApi: Record<BnfApi, TokenBucket>
  readonly rpm: Record<BnfRateBucketName, number>
  readonly maxWaitMs: number
  readonly now: () => number

  constructor(config: BnfRateLimiterConfig) {
    const clock = { now: config.now, sleep: config.sleep }
    const bucket = (rpm: number) => new TokenBucket({ rpm, burst: bucketBurst(rpm), ...clock })
    this.global = bucket(config.globalRpm)
    this.byApi = {
      [BNF_API.CATALOGUE]: bucket(config.catalogueRpm),
      [BNF_API.GALLICA_SRU]: bucket(config.gallicaSruRpm),
      [BNF_API.IIIF]: bucket(config.iiifRpm),
      [BNF_API.ISSUES]: bucket(config.issuesRpm),
      [BNF_API.GRAPHE]: bucket(config.grapheRpm),
    }
    this.rpm = {
      global: config.globalRpm,
      [BNF_API.CATALOGUE]: config.catalogueRpm,
      [BNF_API.GALLICA_SRU]: config.gallicaSruRpm,
      [BNF_API.IIIF]: config.iiifRpm,
      [BNF_API.ISSUES]: config.issuesRpm,
      [BNF_API.GRAPHE]: config.grapheRpm,
    }
    this.maxWaitMs = config.maxWaitMs
    this.now = config.now ?? (() => performance.now())
  }
}

let limiter: BnfRateLimiter | null = null

/** Lazily built from env on the first BnF MCP call; one per process. */
function getLimiter(): BnfRateLimiter {
  if (limiter !== null) return limiter
  const env = requireBnfRateEnv()
  limiter = new BnfRateLimiter({
    globalRpm: env.BNF_MCP_RATE_GLOBAL_RPM,
    catalogueRpm: env.BNF_MCP_RATE_CATALOGUE_RPM,
    gallicaSruRpm: env.BNF_MCP_RATE_GALLICA_SRU_RPM,
    iiifRpm: env.BNF_MCP_RATE_IIIF_RPM,
    issuesRpm: env.BNF_MCP_RATE_ISSUES_RPM,
    grapheRpm: env.BNF_MCP_RATE_GRAPHE_RPM,
    maxWaitMs: env.BNF_MCP_RATE_MAX_WAIT_MS,
  })
  return limiter
}

/**
 * TEST ONLY. Replace the process-wide limiter with one built from `config`
 * (and its injected clock). Named so a production call site is obvious in
 * review — nothing outside a `*.test.ts` may import this.
 */
export function __resetBnfRateLimiterForTests(config: BnfRateLimiterConfig): void {
  limiter = new BnfRateLimiter(config)
}

export type BnfRateGrant =
  | { ok: true }
  | { ok: false; api: BnfRateBucketName; waitedMs: number }

/**
 * Take the tokens for one BnF MCP call: the global bucket, then the tool's API
 * bucket, against one deadline (`now + BNF_MCP_RATE_MAX_WAIT_MS`). Resolves
 * `{ ok: false }` when either cannot be granted in time — it never throws on
 * saturation. It does rethrow a turn abort (`signal`), which ends the wait
 * promptly; the caller handles abort exactly as it handles an aborted transport.
 *
 * A tool that is not in BNF_MCP_TOOL_API is charged to the global bucket only
 * and logged — never let through unlogged, never left unmetered.
 */
export async function acquireBnfMcp(
  tool: string,
  input: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<BnfRateGrant> {
  const l = getLimiter()
  const api = apiForTool(tool)
  if (api === null) console.warn(`[bnf-rate] unmapped tool ${tool} — charged to the global bucket only`)
  const weight = bnfMcpCallWeight(tool, input)
  const start = l.now()
  const deadline = start + l.maxWaitMs

  const take = async (name: BnfRateBucketName, bucket: TokenBucket): Promise<BnfRateGrant> => {
    try {
      await bucket.acquire(weight, deadline, signal)
      return { ok: true }
    } catch (err) {
      if (!(err instanceof RateWaitTimeoutError)) throw err
      const waitedMs = Math.round(l.now() - start)
      console.warn(
        `[bnf-rate] saturated bucket=${name} tool=${tool} weight=${weight} waited=${waitedMs}ms — call not sent`,
      )
      return { ok: false, api: name, waitedMs }
    }
  }

  const global = await take("global", l.global)
  if (!global.ok) return global
  if (api === null) return { ok: true }
  return take(api, l.byApi[api])
}

// ---------------------------------------------------------------------------
// The structured refusal both enforcement points hand the agent
// ---------------------------------------------------------------------------

const BUCKET_LABEL_FR: Record<BnfRateBucketName, string> = {
  global: "l'ensemble des API BnF",
  [BNF_API.CATALOGUE]: "le catalogue",
  [BNF_API.GALLICA_SRU]: "la recherche Gallica",
  [BNF_API.IIIF]: "les documents Gallica (IIIF : manifestes, pages, texte)",
  [BNF_API.ISSUES]: "les numéros de périodiques",
  [BNF_API.GRAPHE]: "data.bnf.fr (graphe)",
}

export type BnfQuotaSaturatedResult = {
  success: false
  rate_limited: true
  api: BnfRateBucketName
  waited_ms: number
  error: string
}

/**
 * The tool result an agent receives when its BnF call was shed. Shared by
 * `corpus_search` (point a) and the registry decorator (point b) so the model
 * reads the same explanation either way: nothing was sent, the quota is shared
 * by every agent of the application, and more parallelism will not help.
 */
export function quotaSaturatedResult(grant: {
  api: BnfRateBucketName
  waitedMs: number
}): BnfQuotaSaturatedResult {
  const rpm = getLimiter().rpm[grant.api]
  return {
    success: false,
    rate_limited: true,
    api: grant.api,
    waited_ms: grant.waitedMs,
    error:
      `Quota BnF saturé pour ${BUCKET_LABEL_FR[grant.api]} (${rpm} requêtes/min partagées par tous ` +
      "les agents de l'application) : rien n'a été envoyé. Attends avant de relancer, réduis le " +
      "nombre de sous-agents, et utilise des pages plus grandes (catalogue : jusqu'à 1000 " +
      "résultats par appel).",
  }
}
