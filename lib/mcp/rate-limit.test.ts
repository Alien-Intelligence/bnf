// lib/mcp/rate-limit.test.ts
// The app-side BnF MCP rate limiter (incident 2026-09-30: one corpus session
// fanned out to 7 sub-agents and made 2 548 catalogue calls in 2.5 h against a
// 100/min quota; nothing on the MCP path throttled). These are the limiter
// semantics every enforcement point relies on, exercised against an injected
// clock so no test waits on real time. Every await that could hang if a rule
// broke is raced against a short real timer, so a regression FAILS.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  BNF_API,
  BNF_MCP_TOOL_API,
  BNF_RATE_LIMIT_FREEZE_MAX_MS,
  GLOBAL_LIMIT,
  RateWaitTimeoutError,
  SlidingWindowLimiter,
  type BnfRateGrant,
  __bnfRateUsageForTests,
  __resetBnfRateLimiterForTests,
  acquireBnfMcp,
  bnfMcpCallWeight,
  isBnfMcpToolName,
  quotaSaturatedResult,
  reportBnfUpstreamRateLimit,
} from "./rate-limit"
import { callBnfTool } from "./call"
import { BnfMcpRateLimitError } from "./errors"
import { BNF_MCP_TOOLS, bnfToolFromPrefixed } from "./tools"

/** A controllable clock: `sleep` advances it instead of waiting. */
function fakeClock() {
  const clock = { t: 0 }
  return {
    clock,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms
    },
  }
}

/** A sleep that only ends when its signal aborts (a waiter that stays queued). */
const blockingSleep = (_ms: number, signal?: AbortSignal) =>
  new Promise<void>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
  })

/** `promise`, or a failure after `ms` of real time — a broken rule fails, never hangs. */
function within<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms).unref()),
  ])
}

const FAR = 10 * 60_000
const WINDOW = 60_000

// --- SlidingWindowLimiter -------------------------------------------------

test("a limit of 5: five immediate grants, the sixth waits for the first to leave the 60 s window", async () => {
  const { clock, now, sleep } = fakeClock()
  const lim = new SlidingWindowLimiter({ limit: 5, now, sleep })
  for (let i = 0; i < 5; i++) await lim.acquire(1, now() + FAR)
  assert.equal(clock.t, 0)
  await lim.acquire(1, now() + FAR)
  assert.equal(clock.t, WINDOW, "granted only once the first grant left the window")
  assert.equal(lim.inWindow(), 1, "the first five left the window as the sixth was granted")
})

test("no burst on top of the rate: any 60 s window holds at most the limit", async () => {
  const { clock, now, sleep } = fakeClock()
  const lim = new SlidingWindowLimiter({ limit: 47, now, sleep })
  const grants: number[] = []
  for (let i = 0; i < 300; i++) {
    await lim.acquire(1, now() + FAR)
    grants.push(clock.t)
    clock.t += 137 // callers keep arriving
  }
  let peak = 0
  let lo = 0
  for (let hi = 0; hi < grants.length; hi++) {
    while (grants[hi] - grants[lo] >= WINDOW) lo++
    peak = Math.max(peak, hi - lo + 1)
  }
  assert.ok(peak <= 47, `sliding-window peak ${peak} ≤ 47`)
})

test("a heavy call waits for its FULL weight (no overdraft); a weight above the limit is refused", async () => {
  const { clock, now, sleep } = fakeClock()
  const lim = new SlidingWindowLimiter({ limit: 10, now, sleep })
  await lim.acquire(6, now() + FAR)
  clock.t += 1_000
  await lim.acquire(6, now() + FAR)
  assert.equal(clock.t, WINDOW, "6 + 6 > 10: the second waits until the first leaves")
  await assert.rejects(lim.acquire(11, now() + FAR), RangeError)
})

test("a deadline shed takes nothing, and the next waiter is still served", async () => {
  const { clock, now, sleep } = fakeClock()
  const lim = new SlidingWindowLimiter({ limit: 1, now, sleep })
  await lim.acquire(1, now() + FAR)
  const a = lim.acquire(1, now() + 500)
  const b = lim.acquire(1, now() + FAR)
  await assert.rejects(within(a), RateWaitTimeoutError)
  await within(b)
  assert.equal(clock.t, WINDOW, "B waited exactly one window — A took nothing")
})

test("a caller aborted while QUEUED leaves at once, takes nothing, and the waiter behind it is served", async () => {
  const { clock, now } = fakeClock()
  let wake: (() => void) | null = null
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
      wake = () => {
        clock.t += ms
        resolve()
      }
    })
  const lim = new SlidingWindowLimiter({ limit: 1, now, sleep })
  await lim.acquire(1, now() + FAR) // full
  const holder = lim.acquire(1, now() + FAR) // sleeping on the window
  const queued = new AbortController()
  const b = lim.acquire(1, now() + FAR, queued.signal) // queued behind the holder
  const c = lim.acquire(1, now() + 2 * FAR) // queued behind B
  queued.abort(new Error("queued turn cancelled"))
  await assert.rejects(within(b), /queued turn cancelled/)
  // Let the holder through, then C: B's slot must not have been consumed.
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setImmediate(r))
    const w = wake
    wake = null
    if (w !== null) (w as () => void)()
  }
  await within(holder)
  await new Promise((r) => setImmediate(r))
  const w2 = wake
  if (w2 !== null) (w2 as () => void)()
  await within(c)
  assert.equal(clock.t, 2 * WINDOW, "C got the slot after the holder's — B consumed nothing")
})

test("a 429 freeze holds the limiter; a smaller Retry-After cannot shorten it", async () => {
  const { clock, now, sleep } = fakeClock()
  const lim = new SlidingWindowLimiter({ limit: 5, now, sleep })
  lim.freezeFor(5_000)
  lim.freezeFor(1_000)
  await lim.acquire(1, now() + FAR)
  assert.equal(clock.t, 5_000, "the longer pause stands")
  lim.freezeFor(5_000)
  await assert.rejects(lim.acquire(1, now() + 1_000), RateWaitTimeoutError, "a pause longer than the budget sheds")
})

test("a non-finite or negative pause is rejected at the boundary, never poisons the limiter", async () => {
  const { now, sleep } = fakeClock()
  const lim = new SlidingWindowLimiter({ limit: 5, now, sleep })
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.throws(() => lim.freezeFor(bad), RangeError, String(bad))
  }
  await within(lim.acquire(1, now() + 300), 500)
  __resetBnfRateLimiterForTests({ ...PROD_RATES, now, sleep })
  for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY, -5]) {
    assert.throws(() => reportBnfUpstreamRateLimit("bnf_search_catalogue", bad), RangeError, String(bad))
  }
  assert.ok((await within(acquireBnfMcp("bnf_search_catalogue", {}, undefined))).ok)
})

// --- acquireBnfMcp: global then API ---------------------------------------

const PROD_RATES = {
  globalRpm: 475,
  catalogueRpm: 47,
  gallicaSruRpm: 95,
  iiifRpm: 285,
  issuesRpm: 47,
  grapheRpm: 47,
  maxWaitMs: 2_000,
}

/** The limiter a saturated grant names; fails the test on any other grant. */
function shedOn(grant: BnfRateGrant): string {
  if (grant.ok || grant.kind !== "saturated") throw new Error(`not a saturation: ${JSON.stringify(grant)}`)
  return grant.api
}

test("acquireBnfMcp takes the global limiter first, then the API limiter", async () => {
  const { now, sleep } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, catalogueRpm: 1, now, sleep })
  assert.ok((await acquireBnfMcp("bnf_search_catalogue", {}, undefined)).ok)
  assert.equal(shedOn(await acquireBnfMcp("bnf_search_catalogue", {}, undefined)), BNF_API.CATALOGUE)
  assert.ok((await acquireBnfMcp("bnf_search_gallica", {}, undefined)).ok, "the other APIs are untouched")
})

test("a saturated global limiter refuses before any API limiter is consulted", async () => {
  const { now, sleep } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, globalRpm: 1, now, sleep })
  assert.ok((await acquireBnfMcp("bnf_search_catalogue", {}, undefined)).ok)
  assert.equal(shedOn(await acquireBnfMcp("bnf_search_gallica", {}, undefined)), GLOBAL_LIMIT)
})

test("a call shed on its API limiter releases its global grant", async () => {
  const { now, sleep } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, globalRpm: 2, catalogueRpm: 1, now, sleep })
  assert.ok((await acquireBnfMcp("bnf_search_catalogue", {}, undefined)).ok)
  assert.equal(shedOn(await acquireBnfMcp("bnf_search_catalogue", {}, undefined)), BNF_API.CATALOGUE)
  assert.equal(__bnfRateUsageForTests(GLOBAL_LIMIT), 1, "the shed call's global grant was released")
  assert.ok((await acquireBnfMcp("bnf_search_gallica", {}, undefined)).ok)
})

test("a call aborted while waiting on its API limiter releases its global grant", async () => {
  const { now } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, globalRpm: 2, catalogueRpm: 1, maxWaitMs: FAR, now, sleep: blockingSleep })
  assert.ok((await acquireBnfMcp("bnf_search_catalogue", {}, undefined)).ok)
  const controller = new AbortController()
  const pending = acquireBnfMcp("bnf_search_catalogue", {}, controller.signal)
  await new Promise((r) => setImmediate(r))
  assert.equal(__bnfRateUsageForTests(GLOBAL_LIMIT), 2, "it holds a global grant while it waits")
  controller.abort(new Error("turn cancelled"))
  await assert.rejects(within(pending), /turn cancelled/)
  assert.equal(__bnfRateUsageForTests(GLOBAL_LIMIT), 1, "released")
})

test("a granted call that is not sent gives back both grants", async () => {
  const { now, sleep } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, now, sleep })
  const grant = await acquireBnfMcp("bnf_search_catalogue", {}, undefined)
  if (!grant.ok) throw new Error("expected a grant")
  assert.equal(__bnfRateUsageForTests(BNF_API.CATALOGUE), 1)
  grant.release()
  grant.release() // twice is harmless
  assert.equal(__bnfRateUsageForTests(BNF_API.CATALOGUE), 0)
  assert.equal(__bnfRateUsageForTests(GLOBAL_LIMIT), 0)
})

test("a BnF 429 freezes the tool's API: Retry-After, the next minute, or the cap", async () => {
  const { clock, now, sleep } = fakeClock()
  const wallClock = () => 42_000 // 18 s before the next clock minute
  __resetBnfRateLimiterForTests({ ...PROD_RATES, maxWaitMs: 10_000, now, sleep, wallClock })
  reportBnfUpstreamRateLimit("bnf_search_catalogue", undefined)
  assert.equal(shedOn(await acquireBnfMcp("bnf_search_catalogue", {}, undefined)), BNF_API.CATALOGUE)
  assert.ok((await acquireBnfMcp("bnf_search_gallica", {}, undefined)).ok, "only that API is paused")

  __resetBnfRateLimiterForTests({ ...PROD_RATES, maxWaitMs: 10_000, now, sleep, wallClock })
  reportBnfUpstreamRateLimit("bnf_get_document_info", 3_000)
  const t0 = clock.t
  assert.ok((await acquireBnfMcp("bnf_get_document_info", {}, undefined)).ok)
  assert.equal(clock.t - t0, 3_000, "waited out the Retry-After")

  __resetBnfRateLimiterForTests({ ...PROD_RATES, maxWaitMs: 60_000, now, sleep, wallClock })
  reportBnfUpstreamRateLimit("bnf_sparql_query", 10 * 3_600_000)
  assert.equal(shedOn(await acquireBnfMcp("bnf_sparql_query", {}, undefined)), BNF_API.GRAPHE)
  clock.t += BNF_RATE_LIMIT_FREEZE_MAX_MS
  assert.ok((await acquireBnfMcp("bnf_sparql_query", {}, undefined)).ok, "capped at 5 minutes")
})

test("inputs the limiter cannot weigh, or heavier than the quota, are refused, not metered", async () => {
  const { now, sleep } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, iiifRpm: 100, now, sleep })
  const bad = await acquireBnfMcp("bnf_get_document_text", { max_pages: "150" }, undefined)
  assert.equal(bad.ok === false && bad.kind, "invalid_input")
  const heavy = await acquireBnfMcp("bnf_get_document_text", { max_pages: 200 }, undefined)
  assert.equal(heavy.ok === false && heavy.kind, "invalid_input", "202 requests can never fit in 100/min")
  assert.equal(__bnfRateUsageForTests(GLOBAL_LIMIT), 0)
})

test("the structured refusal names the API, in the one refusal shape", async () => {
  const { now, sleep } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, catalogueRpm: 1, now, sleep })
  await acquireBnfMcp("bnf_search_catalogue", {}, undefined)
  const refused = await acquireBnfMcp("bnf_search_catalogue", {}, undefined)
  if (refused.ok || refused.kind !== "saturated") throw new Error("expected a saturation")
  const result = quotaSaturatedResult(refused)
  assert.equal(result.success, false)
  assert.equal(result.refused, "bnf_quota_saturated")
  assert.equal(result.rate_limited, true)
  assert.equal(result.api, BNF_API.CATALOGUE)
  assert.match(result.error, /Quota BnF saturé/)
  assert.match(result.error, /au moins une minute/)
})

// --- callBnfTool feeds the 429 back --------------------------------------

async function withFetch(response: () => Response, run: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch
  globalThis.fetch = async () => response()
  try {
    await run()
  } finally {
    globalThis.fetch = real
  }
}

test("callBnfTool: an HTTP 429 with Retry-After pauses the API for exactly that long", async () => {
  const { clock, now, sleep } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, maxWaitMs: 60_000, now, sleep, wallClock: () => 0 })
  await withFetch(
    () => new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
    async () => {
      await assert.rejects(callBnfTool("http://mcp.test/mcp", "t", "bnf_search_catalogue", {}), BnfMcpRateLimitError)
    },
  )
  const t0 = clock.t
  assert.ok((await acquireBnfMcp("bnf_get_catalogue_record", {}, undefined)).ok)
  assert.equal(clock.t - t0, 7_000)
})

test("callBnfTool: an HTTP 429 without Retry-After pauses until the next clock minute", async () => {
  const { clock, now, sleep } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, maxWaitMs: 60_000, now, sleep, wallClock: () => 45_000 })
  await withFetch(
    () => new Response("slow down", { status: 429 }),
    async () => {
      await assert.rejects(callBnfTool("http://mcp.test/mcp", "t", "bnf_search_catalogue", {}), BnfMcpRateLimitError)
    },
  )
  const t0 = clock.t
  assert.ok((await acquireBnfMcp("bnf_get_catalogue_record", {}, undefined)).ok)
  assert.equal(clock.t - t0, 15_000)
})

test("callBnfTool: mcp-bnf's soft status_code 429 envelope pauses the API too", async () => {
  const { clock, now, sleep } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, maxWaitMs: 60_000, now, sleep, wallClock: () => 50_000 })
  const envelope = { success: false, error: "HTTP 429", status_code: 429 }
  await withFetch(
    () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { content: [{ type: "text", text: JSON.stringify(envelope) }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      await assert.rejects(callBnfTool("http://mcp.test/mcp", "t", "bnf_search_catalogue", {}), BnfMcpRateLimitError)
    },
  )
  const t0 = clock.t
  assert.ok((await acquireBnfMcp("bnf_get_catalogue_record", {}, undefined)).ok)
  assert.equal(clock.t - t0, 10_000)
})

test("callBnfTool: a non-JSON body is the contract's BnfMcpError, not a raw SyntaxError", async () => {
  const { now, sleep } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, now, sleep })
  await withFetch(
    () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "application/json" } }),
    async () => {
      await assert.rejects(callBnfTool("http://mcp.test/mcp", "t", "bnf_search_catalogue", {}), (err: unknown) => {
        assert.ok(!(err instanceof SyntaxError))
        assert.match(String(err), /not JSON/)
        return true
      })
    },
  )
})

// --- Tool → API map and weights -------------------------------------------

test("every mcp-bnf tool has an API (the incident's Current State table)", () => {
  const table: Record<string, string> = {
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
  }
  assert.deepEqual({ ...BNF_MCP_TOOL_API }, table)
  assert.deepEqual([...BNF_MCP_TOOLS].sort(), Object.keys(table).sort())
})

test("call weights count upstream requests, not MCP calls", () => {
  assert.deepEqual(bnfMcpCallWeight("bnf_search_catalogue", {}), { ok: true, weight: 1 })
  assert.deepEqual(bnfMcpCallWeight("bnf_get_document_text", {}), { ok: true, weight: 12 })
  assert.deepEqual(bnfMcpCallWeight("bnf_get_document_text", { max_pages: 3 }), { ok: true, weight: 5 })
  assert.deepEqual(bnfMcpCallWeight("bnf_get_document_text", { max_pages: 5_000 }), { ok: true, weight: 202 })
  assert.deepEqual(bnfMcpCallWeight("bnf_get_document_text", { max_pages: 0 }), { ok: true, weight: 3 })
  assert.deepEqual(bnfMcpCallWeight("bnf_find_person", {}), { ok: true, weight: 3 })
  assert.deepEqual(bnfMcpCallWeight("bnf_find_work", {}), { ok: true, weight: 2 })
  for (const bad of ["150", 2.5, null, Number.NaN]) {
    assert.equal(bnfMcpCallWeight("bnf_get_document_text", { max_pages: bad }).ok, false, String(bad))
  }
})

test("tool names: the known set, and a bare or unknown bnf__ name stays BnF egress", () => {
  for (const tool of BNF_MCP_TOOLS) assert.equal(isBnfMcpToolName(tool), true)
  assert.equal(isBnfMcpToolName("bnf_some_future_tool"), false)
  assert.equal(isBnfMcpToolName(""), false)
  assert.equal(isBnfMcpToolName("toString"), false, "no prototype keys")
  assert.equal(bnfToolFromPrefixed("bnf__bnf_search_catalogue"), "bnf_search_catalogue")
  assert.equal(bnfToolFromPrefixed("bnf__"), "", "a bare prefix is a BnF call to an unknown tool")
  assert.equal(bnfToolFromPrefixed("corpus_search"), null)
  assert.equal(bnfToolFromPrefixed("other__bnf_search_catalogue"), null)
})
