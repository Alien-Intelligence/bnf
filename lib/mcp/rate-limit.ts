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
//       (dist/server, dist/claude, dist/openrouter; pinned by
//       rate-limited-registry.test.ts, which drives the real Claude runner), so
//       this throttles the raw `bnf__*` tools the model issues directly, with no
//       SDK change. `onToolStart` cannot do this: it is sync-only, cannot veto.
// Every call acquires the GLOBAL bucket first, then its API bucket, against ONE
// deadline computed when the call is enqueued (BNF_MCP_RATE_MAX_WAIT_MS). A
// call that cannot get its tokens before the deadline is SHED: it never reaches
// BnF, the global tokens it took are refunded (a refused catalogue retry must
// not starve the other APIs), and the caller gets a structured "quota saturé"
// result — never a throw out of the tool loop (CLAUDE_ERROR_PATTERNS §15). One
// acquire per MCP call: a retry by the model acquires again, which is what
// makes 8 agents share 47/min.
//
// A tool that is NOT in BNF_MCP_TOOL_API is REFUSED (rate-limited-registry.ts):
// an unmapped tool has no API bucket, and metering it on the global bucket
// alone would let a new catalogue/SRU tool flood at 475/min.
//
// When BnF answers 429 anyway (HTTP 429 from the proxy, or `status_code: 429`
// inside the MCP result), the API's bucket is FROZEN: for `Retry-After` when
// BnF sends one, otherwise until the next clock-minute boundary — BnF quotas
// are per clock minute, the same rule the broker applies (broker/src/rate.ts).
// The freeze is capped at BNF_RATE_LIMIT_FREEZE_MAX_MS so a garbage header
// cannot stall an API for hours.
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
//     `replicaCount` and fails the render when a share would drop below 1.
//
// Bucket semantics (copied from broker/src/rate.ts, which is a separate
// package and cannot be imported): FIFO acquire chain, deadline-from-enqueue so
// queue time counts against the caller's budget, a shed or aborted acquirer
// still advances the chain, a cancelled caller leaves the queue at once,
// injectable clock and sleep so tests never wait on real time.
import "server-only"

import { BUFFER_SEARCH_MAX_PAGE_SIZE_BY_SOURCE } from "@/lib/constants"
import { requireBnfRateEnv } from "@/lib/env"
import { BNF_MCP_TOOLS, type BnfMcpToolName } from "./tools"

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

/** True for a tool the limiter knows — the ONLY tools allowed to reach BnF. */
export function isBnfMcpToolName(tool: string): tool is BnfMcpToolName {
  return (BNF_MCP_TOOLS as readonly string[]).includes(tool)
}

// ---------------------------------------------------------------------------
// Call weights — upstream requests per MCP call
// ---------------------------------------------------------------------------

/** `bnf_get_document_text` reads `max_pages` pages; mcp-bnf defaults to 10 and
 *  caps at 200 (composite/get_document_text.py). */
const DOCUMENT_TEXT_DEFAULT_PAGES = 10
const DOCUMENT_TEXT_MAX_PAGES = 200
/** …and before the pages it makes two requests: the OAI record and the
 *  pagination listing (composite/get_document_text.py). */
const DOCUMENT_TEXT_FIXED_REQUESTS = 2
/** `bnf_find_person` runs three SPARQL queries (person, count, sample —
 *  semantic/find_person.py:159,224,268). */
const FIND_PERSON_WEIGHT = 3
/** `bnf_find_work` runs two (work, manifestations — semantic/find_work.py:163,260). */
const FIND_WORK_WEIGHT = 2
/** Every other tool makes one upstream request per call. */
const SINGLE_REQUEST_WEIGHT = 1

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** The weight of one call, or why its input cannot be metered. */
export type BnfCallWeight = { ok: true; weight: number } | { ok: false; error: string }

/**
 * How many upstream BnF requests one MCP call stands for. A full-text read
 * costs two fixed requests plus one ALTO per page, and the semantic helpers
 * chain several SPARQL queries. A `max_pages` that is not an integer is
 * REFUSED: mcp-bnf would coerce `"150"` to 150 pages while we would have
 * metered the default 10.
 */
export function bnfMcpCallWeight(tool: BnfMcpToolName, input: Record<string, unknown>): BnfCallWeight {
  switch (tool) {
    case "bnf_get_document_text": {
      const raw = input.max_pages
      if (raw === undefined) {
        return { ok: true, weight: DOCUMENT_TEXT_FIXED_REQUESTS + DOCUMENT_TEXT_DEFAULT_PAGES }
      }
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        return {
          ok: false,
          error: `\`max_pages\` doit être un nombre entier de pages (reçu : ${JSON.stringify(raw)}).`,
        }
      }
      return { ok: true, weight: DOCUMENT_TEXT_FIXED_REQUESTS + clamp(raw, 1, DOCUMENT_TEXT_MAX_PAGES) }
    }
    case "bnf_find_person":
      return { ok: true, weight: FIND_PERSON_WEIGHT }
    case "bnf_find_work":
      return { ok: true, weight: FIND_WORK_WEIGHT }
    default:
      return { ok: true, weight: SINGLE_REQUEST_WEIGHT }
  }
}

// ---------------------------------------------------------------------------
// Token bucket
// ---------------------------------------------------------------------------

/** Burst headroom = rpm / this divisor: a tenth of the minute rate, so a burst
 *  is at most 6 s of quota. */
const BURST_RPM_DIVISOR = 10

/** Burst headroom per bucket: a tenth of the minute rate (≤ 6 s of quota), ≥ 1. */
export function bucketBurst(rpm: number): number {
  return Math.max(1, Math.floor(rpm / BURST_RPM_DIVISOR))
}

/** Upper bound on a 429 freeze, whatever Retry-After says (5 minutes). */
export const BNF_RATE_LIMIT_FREEZE_MAX_MS = 5 * 60_000

const MINUTE_MS = 60_000

/**
 * Float slack when comparing a refilled balance to the tokens needed:
 * `(deficit / rps) * 1000` ms of refill can land a hair under `deficit`
 * (1.2 s at 50 rpm refills 0.99999999996 tokens).
 */
const TOKEN_EPSILON = 1e-9
/** Never sleep less than this: a sub-ms sleep may not move the clock at all,
 *  and the acquire loop would spin without progress. */
const MIN_REFILL_WAIT_MS = 1

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
 * `promise`, or a rejection with the abort reason as soon as `signal` aborts —
 * so a caller queued behind others leaves the queue the moment its turn is
 * cancelled. The queued work itself sees the aborted signal when its turn
 * comes and returns without consuming anything.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      },
    )
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
  /** No token is granted, and none accrues, before this instant (a 429 freeze). */
  private frozenUntil = Number.NEGATIVE_INFINITY
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
   * or aborted acquirer still advances the chain; a caller whose `signal`
   * aborts while it is still QUEUED is released at once.
   *
   * A weight above `burst` is granted once the bucket has refilled to `burst`,
   * and the balance then goes negative (overdraw): a heavy call pays its real
   * cost through the callers behind it instead of deadlocking on a token count
   * the bucket can never hold.
   */
  acquire(weight: number, deadlineMs: number, signal?: AbortSignal): Promise<void> {
    const turn = this.chain.then(() => this.consume(weight, deadlineMs, signal))
    this.chain = turn.catch(() => undefined) // never poison the queue
    return untilAborted(turn, signal)
  }

  /** Give back tokens taken by a call that was then shed downstream. */
  refund(weight: number): void {
    this.refill()
    this.tokens = Math.min(this.burst, this.tokens + weight)
  }

  /**
   * BnF answered 429: grant nothing and accrue nothing for `ms`, starting from
   * an empty balance. Extends an existing freeze, never shortens it.
   */
  freezeFor(ms: number): void {
    const now = this.now()
    this.refill()
    this.tokens = Math.min(this.tokens, 0)
    this.frozenUntil = Math.max(this.frozenUntil, now + ms)
  }

  private async consume(weight: number, deadline: number, signal?: AbortSignal): Promise<void> {
    const need = Math.min(weight, this.burst)
    for (;;) {
      if (signal?.aborted) throw signal.reason
      // Re-derived fresh on every pass (never accumulated), so a caller whose
      // budget expired while queued sheds the moment that is discovered.
      const now = this.now()
      const remaining = deadline - now
      if (now < this.frozenUntil) {
        const frozenMs = this.frozenUntil - now
        if (frozenMs > remaining) throw new RateWaitTimeoutError(frozenMs)
        await this.sleepFn(frozenMs, signal)
        continue
      }
      this.refill()
      if (this.tokens + TOKEN_EPSILON >= need) {
        this.tokens -= weight
        return
      }
      const deficit = need - this.tokens
      const waitMs = Math.max(MIN_REFILL_WAIT_MS, (deficit / this.rps) * 1000)
      if (waitMs > remaining) throw new RateWaitTimeoutError(waitMs)
      await this.sleepFn(waitMs, signal)
    }
  }

  private refill(): void {
    const now = this.now()
    // Nothing accrues during a freeze: the refill starts when it ends.
    const from = Math.max(this.lastRefill, this.frozenUntil)
    if (now <= from) return
    this.tokens = Math.min(this.burst, this.tokens + ((now - from) / 1000) * this.rps)
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
  /** Wall clock for the 429 minute boundary. Defaults to `Date.now()`. */
  wallClock?: () => number
}

class BnfRateLimiter {
  readonly global: TokenBucket
  readonly byApi: Record<BnfApi, TokenBucket>
  readonly rpm: Record<BnfRateBucketName, number>
  readonly maxWaitMs: number
  readonly now: () => number
  readonly wallClock: () => number

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
    this.wallClock = config.wallClock ?? (() => Date.now())
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
 * Build the process-wide limiter now, so a missing or invalid BNF_MCP_RATE_*
 * value throws (naming the variable) where the caller can fail cleanly — at
 * boot (lib/env.ts) and when a registry is built — instead of inside a tool
 * dispatch, where a throw would abort the model's tool loop mid-turn (§15).
 */
export function assertBnfRateLimiterConfigured(): void {
  getLimiter()
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
  | { ok: false; kind: "saturated"; api: BnfRateBucketName; waitedMs: number }
  | { ok: false; kind: "invalid_input"; error: string }

/**
 * Take the tokens for one BnF MCP call: the global bucket, then the tool's API
 * bucket, against one deadline (`now + BNF_MCP_RATE_MAX_WAIT_MS`). Resolves
 * `{ ok: false }` when either cannot be granted in time (the global tokens are
 * then refunded) or when the input cannot be metered — it never throws on
 * saturation. It does rethrow a turn abort (`signal`), queued or sleeping;
 * the caller handles abort exactly as it handles an aborted transport.
 */
export async function acquireBnfMcp(
  tool: BnfMcpToolName,
  input: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<BnfRateGrant> {
  const l = getLimiter()
  const api = BNF_MCP_TOOL_API[tool]
  const weight = bnfMcpCallWeight(tool, input)
  if (!weight.ok) return { ok: false, kind: "invalid_input", error: weight.error }
  const start = l.now()
  const deadline = start + l.maxWaitMs

  const take = async (name: BnfRateBucketName, bucket: TokenBucket): Promise<BnfRateGrant> => {
    try {
      await bucket.acquire(weight.weight, deadline, signal)
      return { ok: true }
    } catch (err) {
      if (!(err instanceof RateWaitTimeoutError)) throw err
      const waitedMs = Math.round(l.now() - start)
      console.warn(
        `[bnf-rate] saturated bucket=${name} tool=${tool} weight=${weight.weight} waited=${waitedMs}ms — call not sent`,
      )
      return { ok: false, kind: "saturated", api: name, waitedMs }
    }
  }

  const global = await take("global", l.global)
  if (!global.ok) return global
  let perApi: BnfRateGrant
  try {
    perApi = await take(api, l.byApi[api])
  } catch (err) {
    // Aborted while waiting on the API bucket: the call is not sent, so the
    // global tokens go back.
    l.global.refund(weight.weight)
    throw err
  }
  if (!perApi.ok) l.global.refund(weight.weight)
  return perApi
}

/**
 * BnF answered 429 for `tool` anyway (quota already exhausted upstream): freeze
 * its API bucket for `retryAfterMs` when BnF sent Retry-After, otherwise until
 * the next clock-minute boundary (BnF quotas are per clock minute), capped at
 * BNF_RATE_LIMIT_FREEZE_MAX_MS. Every agent of the process then waits instead
 * of re-sending into an exhausted quota — the 346 × 429 of the incident.
 */
export function reportBnfUpstreamRateLimit(tool: BnfMcpToolName, retryAfterMs: number | undefined): void {
  const l = getLimiter()
  const api = BNF_MCP_TOOL_API[tool]
  const untilNextMinute = MINUTE_MS - (l.wallClock() % MINUTE_MS)
  const freezeMs = Math.min(retryAfterMs ?? untilNextMinute, BNF_RATE_LIMIT_FREEZE_MAX_MS)
  l.byApi[api].freezeFor(freezeMs)
  console.warn(`[bnf-rate] BnF answered 429 on ${api} (tool=${tool}) — bucket frozen ${Math.round(freezeMs)}ms`)
}

// ---------------------------------------------------------------------------
// The structured results both enforcement points hand the agent
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
      "les agents de l'application) : rien n'a été envoyé. Attends au moins une minute avant de " +
      "relancer, réduis le nombre de sous-agents, et utilise des pages plus grandes (catalogue : " +
      `jusqu'à ${BUFFER_SEARCH_MAX_PAGE_SIZE_BY_SOURCE.catalogue} résultats par appel).`,
  }
}

/** A BnF call the limiter refuses outright (unknown tool, unmeterable input). */
export type BnfCallRefusedResult = { success: false; refused: "bnf_call_refused"; error: string }

export function bnfCallRefusedResult(error: string): BnfCallRefusedResult {
  return { success: false, refused: "bnf_call_refused", error }
}
