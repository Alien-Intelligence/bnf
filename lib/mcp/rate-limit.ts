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
// window, the upstream requests this process SENDS to one BnF API — weighted by
// `bnfMcpCallWeight` — never exceed that API's configured limit, and all of
// them together never exceed the global limit. Each limiter's ledger counts a
// call from its grant until 60 s after it is STAMPED sent: while a granted call still
// waits (on its API limiter after the global grant) it is a RESERVATION that
// counts in every window and never ages; when it is sent it is stamped with the
// send time and leaves the ledger 60 s later. A call is granted only when the
// reservations plus the sends of the trailing 60 s plus its own weight fit.
// Proof: in any window W, take the call X sent in W that was granted LAST. At
// X's grant every other call sent in W was either still reserved or already
// sent within the 60 s before (it was sent after W's start, which is less than
// 60 s before X's send, and X's grant is no later), so the ledger counted it;
// hence W's total ≤ the limit. A call heavier than the whole limit is refused,
// never overdrawn.
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
// Every call reserves on the GLOBAL limiter first, then on its API limiter,
// against ONE deadline computed when the call is enqueued
// (BNF_MCP_RATES.maxWaitMs); both are stamped as sent when `acquireBnfMcp`
// returns. WHERE THE STAMP SITS relative to the real HTTP send, per caller:
//   (a) callBnfTool: the abort check and `fetch(...)` follow the stamp in the
//       same synchronous run — the request leaves at the stamp.
//   (b) withBnfRateLimit: the decorator warms the SDK registry's MCP catalogue
//       (`registry.resolve`, memoised per registry) BEFORE acquiring, so the
//       inner dispatch's `ensureMcpCatalog` is a cache hit and `callMcpServerTool`
//       → `fetch` follows the stamp within microtasks. If the warm-up itself
//       failed (catalogue unavailable), the inner dispatch retries the
//       discovery: the send can then lag the stamp by at most one discovery
//       RPC, which the SDK bounds by the server's `timeoutMs`
//       (BNF_MCP_TIMEOUT_MS). A lag only makes the ledger count the call
//       EARLIER than its send, so the window it occupies starts before the
//       real one — the bound below holds on the stamped times and the real
//       sends trail them by at most that lag.
// Each limiter refuses a deadline already in the past before any grant, and a
// reservation that is neither sent nor released within its TTL
// (BNF_MCP_RATES.maxWaitMs + BNF_MCP_TIMEOUT_MS) is dropped and logged, so a
// lost reservation can never hold capacity for ever. A
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

import { BNF_MCP_TIMEOUT_MS, BUFFER_SEARCH_MAX_PAGE_SIZE_BY_SOURCE } from "@/lib/constants"
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

/** How long an unsent reservation may hold capacity by default (tests); the
 *  process-wide limiters use BNF_MCP_RATES.maxWaitMs + BNF_MCP_TIMEOUT_MS. */
const DEFAULT_RESERVATION_TTL_MS = 2 * BNF_RATE_WINDOW_MS

/** How often a caller blocked only by RESERVATIONS (calls granted, not yet
 *  sent — they cannot be waited out by the clock) re-checks the ledger. */
const RESERVATION_POLL_MS = 25

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

/** One granted call. `sentAt` is null while it is a reservation (granted, not
 *  yet sent); released by identity. */
export type RateGrantTicket = { readonly weight: number; readonly sentAt: number | null }

/** The limiter's own mutable view of a ticket. */
type LedgerTicket = { weight: number; sentAt: number | null; reservedAt: number }

export interface SlidingWindowLimiterOptions {
  /** Upstream requests allowed in any window of `windowMs`. */
  limit: number
  /** Defaults to BNF_RATE_WINDOW_MS. */
  windowMs?: number
  /** Injectable monotonic clock (ms). Defaults to `performance.now()`. */
  now?: () => number
  /** Injectable sleep; receives the abort signal so a cancelled turn stops waiting. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** An unsent reservation older than this is released and logged. */
  reservationTtlMs?: number
  /** Name in the release log. */
  label?: string
}

/**
 * At most `limit` weighted requests SENT in ANY window of `windowMs`. The
 * ledger holds the reservations (granted, not yet sent: they always count) and
 * the sends of the trailing window. A grant of weight w at time t happens only
 * when reservations + sends in (t − windowMs, t] + w fit in `limit`; otherwise
 * the caller waits for the oldest sends to leave the window (or for a
 * reservation to be sent or released), or is shed at its deadline. See the
 * proof in the header: the invariant at every grant bounds every window of
 * sends — no burst on top of the rate, no overdraft. A weight above `limit`
 * could never fit, so it is refused at once.
 */
export class SlidingWindowLimiter {
  readonly limit: number
  private readonly windowMs: number
  /** Granted, not yet sent: counted in every window until sent or released. */
  private reserved = new Set<LedgerTicket>()
  /** Sent, in send order (the clock is monotonic). */
  private sent: LedgerTicket[] = []
  /** No grant before this instant (a 429 freeze). */
  private frozenUntil = Number.NEGATIVE_INFINITY
  /** FIFO chain so acquirers are granted in arrival order, not racing. */
  private chain: Promise<void> = Promise.resolve()
  private readonly now: () => number
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly reservationTtlMs: number
  private readonly label: string

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
    const ttl = opts.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(`SlidingWindowLimiter: reservationTtlMs must be > 0, got ${ttl}`)
    }
    this.reservationTtlMs = ttl
    this.label = opts.label ?? "limiter"
  }

  /**
   * Grant `weight` no later than the ABSOLUTE `deadlineMs` (on this limiter's
   * clock), or reject with RateWaitTimeoutError, as a call SENT at its grant.
   * The deadline is the caller's, computed before the call joined the FIFO
   * chain, so queue time counts against the same budget. A caller whose
   * `signal` aborts leaves the queue at once; if its grant was made in the same
   * instant, the grant is released, so a cancelled call never holds capacity
   * it will not use.
   */
  acquire(weight: number, deadlineMs: number, signal?: AbortSignal): Promise<RateGrantTicket> {
    return this.enqueue(weight, deadlineMs, signal, true)
  }

  /**
   * As `acquire`, but the grant is a RESERVATION: it counts in every window
   * until `markSent` stamps it (or `release` drops it). For a call that must
   * still wait elsewhere before it is sent.
   */
  reserve(weight: number, deadlineMs: number, signal?: AbortSignal): Promise<RateGrantTicket> {
    return this.enqueue(weight, deadlineMs, signal, false)
  }

  /** A reservation was sent now: from here it ages like any send. */
  markSent(ticket: RateGrantTicket): void {
    const own = [...this.reserved].find((t) => t === ticket)
    if (own === undefined) return
    this.reserved.delete(own)
    own.sentAt = this.now()
    this.sent.push(own)
  }

  private enqueue(
    weight: number,
    deadlineMs: number,
    signal: AbortSignal | undefined,
    sentAtGrant: boolean,
  ): Promise<RateGrantTicket> {
    if (!Number.isInteger(weight) || weight < 1) {
      return Promise.reject(new RangeError(`weight must be an integer >= 1, got ${weight}`))
    }
    if (weight > this.limit) {
      return Promise.reject(new RangeError(`weight ${weight} exceeds the limit of ${this.limit} per window`))
    }
    if (!Number.isFinite(deadlineMs)) {
      // A NaN or infinite deadline would wait without bound (§14).
      return Promise.reject(new RangeError(`deadlineMs must be a finite instant, got ${deadlineMs}`))
    }
    const turn = this.chain.then(() => this.grant(weight, deadlineMs, signal, sentAtGrant))
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
    for (const t of this.reserved) if (t === ticket) this.reserved.delete(t)
    this.sent = this.sent.filter((t) => t !== ticket)
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

  /** Reserved weights plus the weights sent in the trailing window (for tests
   *  and the flood replay). */
  inWindow(): number {
    this.evict(this.now())
    return this.used()
  }

  private used(): number {
    let n = 0
    for (const t of this.reserved) n += t.weight
    for (const t of this.sent) n += t.weight
    return n
  }

  private evict(now: number): void {
    for (const t of this.reserved) {
      if (now - t.reservedAt >= this.reservationTtlMs) {
        // A reservation nobody sent nor released (a caller bug): it would hold
        // capacity for ever. Released, and said loudly.
        this.reserved.delete(t)
        console.error(
          `[bnf-rate] ${this.label}: reservation of weight ${t.weight} neither sent nor released ` +
            `within ${this.reservationTtlMs}ms — released`,
        )
      }
    }
    const horizon = now - this.windowMs
    const first = this.sent[0]
    if (first !== undefined && first.sentAt !== null && first.sentAt <= horizon) {
      this.sent = this.sent.filter((t) => t.sentAt !== null && t.sentAt > horizon)
    }
  }

  /**
   * When `weight` more would fit: now, the instant enough of the oldest sends
   * leave the window, or null when even an empty window of sends would not
   * make room — only a reservation being sent or released can.
   */
  private fitsAt(now: number, weight: number): number | null {
    let used = this.used()
    if (used + weight <= this.limit) return now
    for (const t of this.sent) {
      used -= t.weight
      if (used + weight <= this.limit && t.sentAt !== null) return t.sentAt + this.windowMs
    }
    return null
  }

  private async grant(
    weight: number,
    deadline: number,
    signal: AbortSignal | undefined,
    sentAtGrant: boolean,
  ): Promise<RateGrantTicket> {
    for (;;) {
      if (signal?.aborted) throw signal.reason
      const now = this.now()
      // An expired deadline is refused BEFORE any grant: a caller whose budget
      // is spent never takes capacity.
      if (now > deadline) throw new RateWaitTimeoutError(0)
      this.evict(now)
      const fits = this.fitsAt(now, weight)
      const at = fits === null ? null : Math.max(this.frozenUntil, fits)
      if (at !== null && at <= now) {
        const ticket: LedgerTicket = { weight, sentAt: sentAtGrant ? now : null, reservedAt: now }
        if (sentAtGrant) this.sent.push(ticket)
        else this.reserved.add(ticket)
        return ticket
      }
      if (at !== null ? at > deadline : now >= deadline) {
        throw new RateWaitTimeoutError((at ?? deadline) - now)
      }
      // Blocked by reservations: re-check soon (never past the deadline).
      const wakeAt = at ?? Math.min(deadline, Math.max(this.frozenUntil, now + RESERVATION_POLL_MS))
      await this.sleepFn(Math.max(MIN_WAIT_MS, wakeAt - now), signal)
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
    // An unsent reservation can legitimately live as long as the wait budget
    // plus one MCP call; past that it is a lost reservation and is released.
    const reservationTtlMs = config.maxWaitMs + BNF_MCP_TIMEOUT_MS
    const limiter = (label: BnfRateBucketName, limit: number) =>
      new SlidingWindowLimiter({ limit, now: config.now, sleep: config.sleep, reservationTtlMs, label })
    this.global = limiter(GLOBAL_LIMIT, config.globalRpm)
    this.byApi = {
      [BNF_API.CATALOGUE]: limiter(BNF_API.CATALOGUE, config.catalogueRpm),
      [BNF_API.GALLICA_SRU]: limiter(BNF_API.GALLICA_SRU, config.gallicaSruRpm),
      [BNF_API.IIIF]: limiter(BNF_API.IIIF, config.iiifRpm),
      [BNF_API.ISSUES]: limiter(BNF_API.ISSUES, config.issuesRpm),
      [BNF_API.GRAPHE]: limiter(BNF_API.GRAPHE, config.grapheRpm),
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
  limiter = new BnfRateLimiter(requireBnfRateEnv())
  return limiter
}

/**
 * Build the process-wide limiter now, so a missing or invalid BNF_MCP_RATES
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

/** A granted call, already counted as sent at the instant it was returned:
 *  the caller sends it synchronously, or calls `release()` if it does not. */
export type BnfRateGrant =
  | { ok: true; release: () => void }
  | { ok: false; kind: "saturated"; api: BnfRateBucketName; waitedMs: number }
  | { ok: false; kind: "invalid_input"; error: string }

/**
 * Take the capacity for one BnF MCP call: a reservation on the global limiter,
 * then on the tool's API limiter, against one deadline
 * (`now + BNF_MCP_RATES.maxWaitMs`); then both are stamped as SENT, now — the
 * global reservation counted throughout the API wait and never aged. Resolves
 * `{ ok: false }` when either cannot grant in time (the global reservation is
 * then released) or when the input cannot be metered — a weight over a limit
 * included. It rethrows a turn abort (`signal`), queued or sleeping, after
 * releasing whatever it held.
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
      return { ok: true, ticket: await from.reserve(weight.weight, deadline, signal) }
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
  // Sent now: the caller sends synchronously after this returns (or releases).
  l.global.markSent(global.ticket)
  l.byApi[api].markSent(apiTicket)
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
