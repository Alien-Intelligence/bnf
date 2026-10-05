// lib/mcp/rate-limit.ts
// App-side rate limiter for EVERY BnF MCP call this process dispatches.
//
// Why it exists (incident 2026-09-30, ai-memories/tech/incidents/
// 2026-09-30-bnf-catalogue-sru-flood.md): one corpus session fanned out to 7
// spawn_research children and made 2 548 catalogue searches in 2.5 h. Nothing
// on the app → mcp-bnf → platform proxy → BnF path throttled, so BnF answered
// 346 × 429 and 252 × 500 on the catalogue connector. The limits below are the
// interface key's quotas × 0.95 (helm `config.bnfMcpRate`, divided by the
// replica count), shared by the parent turn, every sub-agent and the app's own
// corpus_search.
//
// THE GUARANTEE, provable from SlidingWindowLimiter below: in ANY 60 s sliding
// window, the upstream requests this process sends to one BnF API — weighted by
// `bnfMcpCallWeight` — never exceed that API's configured limit, and all of
// them together never exceed the global limit. A call is granted only when the
// weights granted in the trailing 60 s plus its own fit; a call heavier than
// the whole limit is refused, never overdrawn.
//
// COVERAGE CONTRACT (Decision 17 of the Track E plan). One process-wide set of
// limiters, two enforcement points:
//   (a) `callBnfTool` (lib/mcp/call.ts) — the app-made calls: corpus_search and
//       its zero-result probe.
//   (b) `withBnfRateLimit(registry)` (lib/mcp/rate-limited-registry.ts) — a
//       ToolRegistry decorator wrapping `dispatch`, applied to the parent turn
//       registry (lib/agent/tools/registry-factory.ts) and to every
//       spawn_research child registry (lib/agent/tools/spawn.ts). Every
//       chat-sdk runner calls `.dispatch` on the registry it was handed, so this
//       throttles the raw `bnf__*` tools the model issues directly, with no SDK
//       change. Pinned by rate-limited-registry-runner.test.ts, which drives
//       BOTH runners (runClaudeSdk and runOpenRouterSdk, the production
//       provider) over the registry `buildTurnScopedRegistry` builds, against
//       local fake model and mcp-bnf endpoints. `onToolStart` cannot do this:
//       it is sync-only and cannot veto.
// Every call acquires the GLOBAL limiter first, then its API limiter, against
// ONE deadline computed when the call is enqueued (BNF_MCP_RATE_MAX_WAIT_MS). A
// call that cannot be granted before the deadline is SHED: it never reaches
// BnF, every grant it took is released (a refused catalogue retry must not
// starve the other APIs, and a cancelled caller frees what it held even when
// the grant landed as it was cancelled), and the caller gets a structured
// "quota saturé" result — never a throw out of the tool loop
// (CLAUDE_ERROR_PATTERNS §15). One acquire per MCP call: a retry by the model
// acquires again, which is what makes 8 agents share 47/min.
//
// A tool that is NOT in BNF_MCP_TOOL_API is REFUSED (rate-limited-registry.ts):
// an unmapped tool has no API bucket, and metering it on the global bucket
// alone would let a new catalogue/SRU tool flood at 475/min.
//
// When BnF answers 429 anyway (HTTP 429 from the proxy, or `status_code: 429`
// inside the MCP result), the API's limiter is FROZEN: for `Retry-After` when
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
//   - Other replicas. The limiters are in-memory and exact for the ONE replica
//     the chart runs (Decision 19); the chart divides every rate by
//     `replicaCount` and fails the render when a share would drop below 1.
//
// Queue semantics: FIFO acquire chain, deadline-from-enqueue so queue time
// counts against the caller's budget, a shed or aborted acquirer still advances
// the chain, a cancelled caller leaves the queue at once, injectable clock and
// sleep so tests never wait on real time.
import "server-only"

import { BUFFER_SEARCH_MAX_PAGE_SIZE_BY_SOURCE } from "@/lib/constants"
import { requireBnfRateEnv } from "@/lib/env"
import { toolRefusal, type ToolRefusal } from "@/lib/agent/tools/failure"
import { BNF_MCP_TOOL, type BnfMcpToolName } from "./tools"

// ---------------------------------------------------------------------------
// BnF APIs behind mcp-bnf, and which tool hits which
// ---------------------------------------------------------------------------

/** The BnF APIs the interface key is quota'd on, one limiter each. */
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

/** The name of the process-wide ceiling every call also draws on. */
export const GLOBAL_LIMIT = "global" as const

/** The limiter a refusal names: one of the APIs, or the global ceiling. */
export type BnfRateBucketName = BnfApi | typeof GLOBAL_LIMIT

/**
 * mcp-bnf tool → the BnF API it calls (from the clients each tool module
 * instantiates in MCPs/mcp-bnf/src/tools/*). `satisfies` over the tool-name
 * union makes a tool without an API a type error; the test pins the table.
 */
export const BNF_MCP_TOOL_API = {
  [BNF_MCP_TOOL.SEARCH_CATALOGUE]: BNF_API.CATALOGUE,
  [BNF_MCP_TOOL.GET_CATALOGUE_RECORD]: BNF_API.CATALOGUE,
  [BNF_MCP_TOOL.SEARCH_GALLICA]: BNF_API.GALLICA_SRU,
  [BNF_MCP_TOOL.GET_SEARCH_FACETS]: BNF_API.GALLICA_SRU,
  [BNF_MCP_TOOL.GET_MANIFEST]: BNF_API.IIIF,
  [BNF_MCP_TOOL.GET_IMAGE_INFO]: BNF_API.IIIF,
  [BNF_MCP_TOOL.GET_IMAGE_URL]: BNF_API.IIIF,
  [BNF_MCP_TOOL.GET_PAGE_OCR_BOXES]: BNF_API.IIIF,
  [BNF_MCP_TOOL.GET_DOCUMENT_INFO]: BNF_API.IIIF,
  [BNF_MCP_TOOL.GET_DOCUMENT_PAGES]: BNF_API.IIIF,
  [BNF_MCP_TOOL.GET_DOCUMENT_TOC]: BNF_API.IIIF,
  [BNF_MCP_TOOL.GET_PAGE_TEXT]: BNF_API.IIIF,
  [BNF_MCP_TOOL.GET_DOCUMENT_TEXT]: BNF_API.IIIF,
  [BNF_MCP_TOOL.GET_PERIODICAL_ISSUES]: BNF_API.ISSUES,
  [BNF_MCP_TOOL.SPARQL_QUERY]: BNF_API.GRAPHE,
  [BNF_MCP_TOOL.FIND_PERSON]: BNF_API.GRAPHE,
  [BNF_MCP_TOOL.FIND_WORK]: BNF_API.GRAPHE,
  [BNF_MCP_TOOL.RESOLVE_ENTITY]: BNF_API.GRAPHE,
} as const satisfies Record<BnfMcpToolName, BnfApi>

/** True for a tool the limiter knows — the ONLY tools allowed to reach BnF. */
export function isBnfMcpToolName(tool: string): tool is BnfMcpToolName {
  return Object.hasOwn(BNF_MCP_TOOL_API, tool)
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
    case BNF_MCP_TOOL.GET_DOCUMENT_TEXT: {
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
    case BNF_MCP_TOOL.FIND_PERSON:
      return { ok: true, weight: FIND_PERSON_WEIGHT }
    case BNF_MCP_TOOL.FIND_WORK:
      return { ok: true, weight: FIND_WORK_WEIGHT }
    default:
      return { ok: true, weight: SINGLE_REQUEST_WEIGHT }
  }
}

// ---------------------------------------------------------------------------
// The sliding-window limiter
// ---------------------------------------------------------------------------

/** The quota window BnF counts in, and the one the guarantee is stated over. */
export const BNF_RATE_WINDOW_MS = 60_000

/** Upper bound on a 429 freeze, whatever Retry-After says (5 minutes). */
export const BNF_RATE_LIMIT_FREEZE_MAX_MS = 5 * 60_000

/** Never sleep less than this: a sub-ms sleep may not move the clock at all,
 *  and the acquire loop would spin without progress. */
const MIN_WAIT_MS = 1

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
 * Thrown by `SlidingWindowLimiter.acquire()` when the weight cannot be granted
 * before the caller's deadline. The limiter maps it to a structured refusal;
 * it never leaves `acquireBnfMcp`.
 */
export class RateWaitTimeoutError extends Error {
  constructor(public readonly neededMs: number) {
    super(`rate budget exhausted: capacity needs ~${Math.round(neededMs)}ms, over the deadline`)
    this.name = "RateWaitTimeoutError"
  }
}

/** One granted call: its weight, at its grant time. Released by identity. */
export type RateGrantTicket = { readonly at: number; readonly weight: number }

export interface SlidingWindowLimiterOptions {
  /** Upstream requests allowed in any window of `windowMs`. */
  limit: number
  /** Defaults to BNF_RATE_WINDOW_MS. */
  windowMs?: number
  /** Injectable monotonic clock (ms). Defaults to `performance.now()`. */
  now?: () => number
  /** Injectable sleep; receives the abort signal so a cancelled turn stops waiting. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * At most `limit` weighted requests in ANY window of `windowMs`: a ledger of
 * the grants of the trailing window. A grant of weight w at time t happens
 * only when the weights granted in (t − windowMs, t] plus w fit in `limit`;
 * otherwise the caller waits for the oldest grants to leave the window, or is
 * shed at its deadline. That invariant holds at every grant, so it holds over
 * every sliding window — there is no burst on top of the rate and no
 * overdraft. A weight above `limit` could never fit, so it is refused at once.
 */
export class SlidingWindowLimiter {
  readonly limit: number
  private readonly windowMs: number
  private granted: RateGrantTicket[] = []
  /** No grant before this instant (a 429 freeze). */
  private frozenUntil = Number.NEGATIVE_INFINITY
  /** FIFO chain so acquirers are granted in arrival order, not racing. */
  private chain: Promise<void> = Promise.resolve()
  private readonly now: () => number
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>

  constructor(opts: SlidingWindowLimiterOptions) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new Error(`SlidingWindowLimiter: limit must be an integer >= 1, got ${opts.limit}`)
    }
    const windowMs = opts.windowMs ?? BNF_RATE_WINDOW_MS
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(`SlidingWindowLimiter: windowMs must be > 0, got ${windowMs}`)
    }
    this.limit = opts.limit
    this.windowMs = windowMs
    this.now = opts.now ?? (() => performance.now())
    this.sleepFn = opts.sleep ?? realSleep
  }

  /**
   * Grant `weight` no later than the ABSOLUTE `deadlineMs` (on this limiter's
   * clock), or reject with RateWaitTimeoutError. The deadline is the caller's,
   * computed before the call joined the FIFO chain, so queue time counts
   * against the same budget. A caller whose `signal` aborts leaves the queue at
   * once; if its grant was made in the same instant, the grant is released, so
   * a cancelled call never holds capacity it will not use.
   */
  acquire(weight: number, deadlineMs: number, signal?: AbortSignal): Promise<RateGrantTicket> {
    if (!Number.isInteger(weight) || weight < 1) {
      return Promise.reject(new RangeError(`weight must be an integer >= 1, got ${weight}`))
    }
    if (weight > this.limit) {
      return Promise.reject(new RangeError(`weight ${weight} exceeds the limit of ${this.limit} per window`))
    }
    const turn = this.chain.then(() => this.grant(weight, deadlineMs, signal))
    this.chain = turn.then(
      () => undefined,
      () => undefined, // never poison the queue
    )
    if (signal === undefined) return turn
    return new Promise<RateGrantTicket>((resolve, reject) => {
      let left = false
      const onAbort = () => {
        left = true
        reject(signal.reason)
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
      turn.then(
        (ticket) => {
          signal.removeEventListener("abort", onAbort)
          if (left) this.release(ticket)
          else resolve(ticket)
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort)
          if (!left) reject(err)
        },
      )
    })
  }

  /** Give back a grant whose call was not sent. Releasing twice is a no-op. */
  release(ticket: RateGrantTicket): void {
    this.granted = this.granted.filter((t) => t !== ticket)
  }

  /**
   * BnF answered 429: grant nothing for `ms`. Extends an existing freeze,
   * never shortens it. `ms` must be a finite, non-negative number — a NaN
   * would poison every later comparison.
   */
  freezeFor(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`freezeFor: ms must be a finite number >= 0, got ${ms}`)
    }
    this.frozenUntil = Math.max(this.frozenUntil, this.now() + ms)
  }

  /** Weights granted in the trailing window (for tests and the flood replay). */
  inWindow(): number {
    this.evict(this.now())
    return this.granted.reduce((n, t) => n + t.weight, 0)
  }

  private evict(now: number): void {
    const horizon = now - this.windowMs
    if (this.granted.length > 0 && this.granted[0].at <= horizon) {
      this.granted = this.granted.filter((t) => t.at > horizon)
    }
  }

  /** When `weight` more would fit, given the grants of the trailing window. */
  private fitsAt(now: number, weight: number): number {
    let used = this.granted.reduce((n, t) => n + t.weight, 0)
    if (used + weight <= this.limit) return now
    // Oldest first (grants are appended in time order): walk until enough leave.
    for (const t of this.granted) {
      used -= t.weight
      if (used + weight <= this.limit) return t.at + this.windowMs
    }
    return now // unreachable: weight <= limit, so an empty ledger always fits
  }

  private async grant(weight: number, deadline: number, signal?: AbortSignal): Promise<RateGrantTicket> {
    for (;;) {
      if (signal?.aborted) throw signal.reason
      const now = this.now()
      this.evict(now)
      const at = Math.max(this.frozenUntil, this.fitsAt(now, weight))
      if (at <= now) {
        const ticket: RateGrantTicket = { at: now, weight }
        this.granted.push(ticket)
        return ticket
      }
      if (at > deadline) throw new RateWaitTimeoutError(at - now)
      await this.sleepFn(Math.max(MIN_WAIT_MS, at - now), signal)
    }
  }
}

// ---------------------------------------------------------------------------
// The process-wide limiter set
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
  readonly global: SlidingWindowLimiter
  readonly byApi: Record<BnfApi, SlidingWindowLimiter>
  readonly rpm: Record<BnfRateBucketName, number>
  readonly maxWaitMs: number
  readonly now: () => number
  readonly wallClock: () => number

  constructor(config: BnfRateLimiterConfig) {
    const limiter = (limit: number) => new SlidingWindowLimiter({ limit, now: config.now, sleep: config.sleep })
    this.global = limiter(config.globalRpm)
    this.byApi = {
      [BNF_API.CATALOGUE]: limiter(config.catalogueRpm),
      [BNF_API.GALLICA_SRU]: limiter(config.gallicaSruRpm),
      [BNF_API.IIIF]: limiter(config.iiifRpm),
      [BNF_API.ISSUES]: limiter(config.issuesRpm),
      [BNF_API.GRAPHE]: limiter(config.grapheRpm),
    }
    this.rpm = {
      [GLOBAL_LIMIT]: config.globalRpm,
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

/** TEST ONLY: weights granted in the trailing window, per limiter. */
export function __bnfRateUsageForTests(name: BnfRateBucketName): number {
  const l = getLimiter()
  return name === GLOBAL_LIMIT ? l.global.inWindow() : l.byApi[name].inWindow()
}

/** A granted call. `release()` gives its capacity back if it is not sent. */
export type BnfRateGrant =
  | { ok: true; release: () => void }
  | { ok: false; kind: "saturated"; api: BnfRateBucketName; waitedMs: number }
  | { ok: false; kind: "invalid_input"; error: string }

/**
 * Take the capacity for one BnF MCP call: the global limiter, then the tool's
 * API limiter, against one deadline (`now + BNF_MCP_RATE_MAX_WAIT_MS`).
 * Resolves `{ ok: false }` when either cannot grant in time (the global grant
 * is then released) or when the input cannot be metered — a weight over a
 * limit included. It rethrows a turn abort (`signal`), queued or sleeping,
 * after releasing whatever it held.
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
  const ceiling = Math.min(l.global.limit, l.byApi[api].limit)
  if (weight.weight > ceiling) {
    return {
      ok: false,
      kind: "invalid_input",
      error:
        `Cet appel compte ${weight.weight} requêtes BnF, au-delà du quota de ${ceiling} par minute : ` +
        "il ne peut jamais passer. Réduis `max_pages`.",
    }
  }
  const start = l.now()
  const deadline = start + l.maxWaitMs

  const take = async (
    name: BnfRateBucketName,
    from: SlidingWindowLimiter,
  ): Promise<{ ok: true; ticket: RateGrantTicket } | Extract<BnfRateGrant, { kind: "saturated" }>> => {
    try {
      return { ok: true, ticket: await from.acquire(weight.weight, deadline, signal) }
    } catch (err) {
      if (!(err instanceof RateWaitTimeoutError)) throw err
      const waitedMs = Math.round(l.now() - start)
      console.warn(
        `[bnf-rate] saturated limit=${name} tool=${tool} weight=${weight.weight} waited=${waitedMs}ms — call not sent`,
      )
      return { ok: false, kind: "saturated", api: name, waitedMs }
    }
  }

  const global = await take(GLOBAL_LIMIT, l.global)
  if (!global.ok) return global
  let perApi: Awaited<ReturnType<typeof take>>
  try {
    perApi = await take(api, l.byApi[api])
  } catch (err) {
    l.global.release(global.ticket)
    throw err
  }
  if (!perApi.ok) {
    l.global.release(global.ticket)
    return perApi
  }
  const apiTicket = perApi.ticket
  return {
    ok: true,
    release: () => {
      l.global.release(global.ticket)
      l.byApi[api].release(apiTicket)
    },
  }
}

/**
 * BnF answered 429 for `tool` anyway (quota already exhausted upstream): freeze
 * its API limiter for `retryAfterMs` when BnF sent Retry-After, otherwise until
 * the next clock-minute boundary (BnF quotas are per clock minute), capped at
 * BNF_RATE_LIMIT_FREEZE_MAX_MS. A `retryAfterMs` that is not a finite number
 * >= 0 is a caller bug and is rejected here, at the boundary.
 */
export function reportBnfUpstreamRateLimit(tool: BnfMcpToolName, retryAfterMs: number | undefined): void {
  if (retryAfterMs !== undefined && (!Number.isFinite(retryAfterMs) || retryAfterMs < 0)) {
    throw new RangeError(`reportBnfUpstreamRateLimit: retryAfterMs must be a finite number >= 0, got ${retryAfterMs}`)
  }
  const l = getLimiter()
  const api = BNF_MCP_TOOL_API[tool]
  const untilNextMinute = BNF_RATE_WINDOW_MS - (l.wallClock() % BNF_RATE_WINDOW_MS)
  const freezeMs = Math.min(retryAfterMs ?? untilNextMinute, BNF_RATE_LIMIT_FREEZE_MAX_MS)
  l.byApi[api].freezeFor(freezeMs)
  console.warn(`[bnf-rate] BnF answered 429 on ${api} (tool=${tool}) — paused ${Math.round(freezeMs)}ms`)
}

// ---------------------------------------------------------------------------
// The structured results both enforcement points hand the agent
// ---------------------------------------------------------------------------

const BUCKET_LABEL_FR: Record<BnfRateBucketName, string> = {
  [GLOBAL_LIMIT]: "l'ensemble des API BnF",
  [BNF_API.CATALOGUE]: "le catalogue",
  [BNF_API.GALLICA_SRU]: "la recherche Gallica",
  [BNF_API.IIIF]: "les documents Gallica (IIIF : manifestes, pages, texte)",
  [BNF_API.ISSUES]: "les numéros de périodiques",
  [BNF_API.GRAPHE]: "data.bnf.fr (graphe)",
}

/** The refusal reasons the limiter gives (failure.ts's one refusal shape). */
export const BNF_REFUSAL = {
  QUOTA_SATURATED: "bnf_quota_saturated",
  CALL_REFUSED: "bnf_call_refused",
} as const

export type BnfQuotaSaturatedResult = ToolRefusal<typeof BNF_REFUSAL.QUOTA_SATURATED> & {
  rate_limited: true
  api: BnfRateBucketName
  waited_ms: number
}

/**
 * The tool result an agent receives when its BnF call was shed. Shared by
 * `corpus_search` (point a) and the registry decorator (point b) so the model
 * reads the same explanation either way: nothing was sent, the quota is shared
 * by every agent of the application, and more parallelism will not help.
 */
export function quotaSaturatedResult(grant: { api: BnfRateBucketName; waitedMs: number }): BnfQuotaSaturatedResult {
  const rpm = getLimiter().rpm[grant.api]
  const error =
    `Quota BnF saturé pour ${BUCKET_LABEL_FR[grant.api]} (${rpm} requêtes/min partagées par tous ` +
    "les agents de l'application) : rien n'a été envoyé. Attends au moins une minute avant de " +
    "relancer, réduis le nombre de sous-agents, et utilise des pages plus grandes (catalogue : " +
    `jusqu'à ${BUFFER_SEARCH_MAX_PAGE_SIZE_BY_SOURCE.catalogue} résultats par appel).`
  return {
    ...toolRefusal(BNF_REFUSAL.QUOTA_SATURATED, error),
    rate_limited: true,
    api: grant.api,
    waited_ms: grant.waitedMs,
  }
}

/** A BnF call the limiter refuses outright (unknown tool, unmeterable input). */
export type BnfCallRefusedResult = ToolRefusal<typeof BNF_REFUSAL.CALL_REFUSED>

export function bnfCallRefusedResult(error: string): BnfCallRefusedResult {
  return toolRefusal(BNF_REFUSAL.CALL_REFUSED, error)
}
