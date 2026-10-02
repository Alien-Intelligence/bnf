// lib/mcp/rate-limit.test.ts
// The app-side BnF MCP rate limiter (incident 2026-09-30: one corpus session
// fanned out to 7 sub-agents and made 2 548 catalogue calls in 2.5 h against a
// 100/min quota; nothing on the MCP path throttled). These are the bucket
// semantics every enforcement point relies on, exercised against an injected
// clock so no test waits on real time.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  BNF_API,
  BNF_MCP_TOOL_API,
  RateWaitTimeoutError,
  TokenBucket,
  __resetBnfRateLimiterForTests,
  type BnfRateGrant,
  BNF_RATE_LIMIT_FREEZE_MAX_MS,
  acquireBnfMcp,
  bnfMcpCallWeight,
  bucketBurst,
  isBnfMcpToolName,
  quotaSaturatedResult,
  reportBnfUpstreamRateLimit,
} from "./rate-limit"
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

const FAR = 10 * 60_000

// --- TokenBucket ----------------------------------------------------------

test("at 50 rpm with burst 5: five immediate grants, then one every 1.2 s", async () => {
  const { clock, now, sleep } = fakeClock()
  const bucket = new TokenBucket({ rpm: 50, burst: 5, now, sleep })

  for (let i = 0; i < 5; i++) await bucket.acquire(1, now() + FAR)
  assert.equal(clock.t, 0, "the burst is granted without waiting")

  await bucket.acquire(1, now() + FAR)
  assert.ok(Math.abs(clock.t - 1200) < 1, `6th grant waited one refill (${clock.t} ms)`)
  await bucket.acquire(1, now() + FAR)
  assert.ok(Math.abs(clock.t - 2400) < 1, `7th grant waited another refill (${clock.t} ms)`)
})

test("a deadline shed rejects without consuming tokens and the next waiter is still served", async () => {
  const { clock, now, sleep } = fakeClock()
  const bucket = new TokenBucket({ rpm: 50, burst: 1, now, sleep })
  await bucket.acquire(1, now() + FAR) // empty the bucket

  // Enqueued together: A has 500 ms of budget (a refill takes 1 200 ms), B has plenty.
  const a = bucket.acquire(1, now() + 500)
  const b = bucket.acquire(1, now() + FAR)
  await assert.rejects(a, RateWaitTimeoutError)
  await b
  assert.ok(Math.abs(clock.t - 1200) < 1, "B paid exactly one refill — A took nothing")
})

test("a weight above burst waits for the bucket to fill to burst, then overdraws", async () => {
  const { clock, now, sleep } = fakeClock()
  const bucket = new TokenBucket({ rpm: 50, burst: 5, now, sleep })
  for (let i = 0; i < 5; i++) await bucket.acquire(1, now() + FAR) // tokens = 0

  await bucket.acquire(21, now() + FAR)
  assert.ok(Math.abs(clock.t - 6000) < 1, `waited for 5 tokens (burst), not 21 (${clock.t} ms)`)

  // Balance is now -16: the next unit call pays 17 refills.
  await bucket.acquire(1, now() + FAR)
  assert.ok(Math.abs(clock.t - 6000 - 17 * 1200) < 1, `overdraw repaid before the next grant (${clock.t} ms)`)
})

test("an abort during the wait rejects promptly with the abort reason", async () => {
  const { now } = fakeClock()
  // A sleep that only ends when aborted: the test fails by timing out if the
  // bucket ignores the signal.
  const sleep = (_ms: number, signal?: AbortSignal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  const bucket = new TokenBucket({ rpm: 50, burst: 1, now, sleep })
  await bucket.acquire(1, now() + FAR) // empty

  const controller = new AbortController()
  const pending = bucket.acquire(1, now() + FAR, controller.signal)
  controller.abort(new Error("turn cancelled"))
  await assert.rejects(pending, /turn cancelled/)

  // The chain is not poisoned: a later acquire with a non-blocking sleep works.
  const { now: now2, sleep: sleep2 } = fakeClock()
  const bucket2 = new TokenBucket({ rpm: 50, burst: 1, now: now2, sleep: sleep2 })
  await bucket2.acquire(1, now2() + FAR)
  await bucket2.acquire(1, now2() + FAR)
})

test("a caller aborted while QUEUED leaves at once and consumes nothing", async () => {
  const { now } = fakeClock()
  // A sleep that only ends when aborted: A holds the FIFO chain indefinitely.
  const sleep = (_ms: number, signal?: AbortSignal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  const bucket = new TokenBucket({ rpm: 50, burst: 1, now, sleep })
  await bucket.acquire(1, now() + FAR) // empty

  const holder = new AbortController()
  const queued = new AbortController()
  const a = bucket.acquire(1, now() + FAR, holder.signal) // sleeping on the refill
  const b = bucket.acquire(1, now() + FAR, queued.signal) // queued behind A
  queued.abort(new Error("queued turn cancelled"))
  // B rejects while A still holds the chain — it did not wait for its turn.
  await assert.rejects(b, /queued turn cancelled/)

  holder.abort(new Error("holder cancelled"))
  await assert.rejects(a, /holder cancelled/)
})

test("a 429 freeze holds the bucket for Retry-After, then refills from the end of the freeze", async () => {
  const { clock, now, sleep } = fakeClock()
  const bucket = new TokenBucket({ rpm: 60, burst: 5, now, sleep })
  bucket.freezeFor(5_000)
  await bucket.acquire(1, now() + FAR)
  // 5 s frozen, then one token at 60 rpm (1 s) — the tokens it held are gone.
  assert.ok(Math.abs(clock.t - 6_000) < 1, `waited out the freeze and one refill (${clock.t} ms)`)
  // A freeze longer than the caller's budget sheds it immediately.
  bucket.freezeFor(5_000)
  await assert.rejects(bucket.acquire(1, now() + 1_000), RateWaitTimeoutError)
})

test("burst is a tenth of the per-minute rate, never below 1", () => {
  assert.equal(bucketBurst(47), 4)
  assert.equal(bucketBurst(475), 47)
  assert.equal(bucketBurst(6), 1)
  assert.equal(bucketBurst(1), 1)
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

/** The bucket a saturated grant names; fails the test on any other grant. */
function shedOn(grant: BnfRateGrant): string {
  assert.equal(grant.ok, false, "expected the call to be shed")
  if (grant.ok || grant.kind !== "saturated") throw new Error(`not a saturation: ${JSON.stringify(grant)}`)
  return grant.api
}

test("acquireBnfMcp takes the global bucket first, then the API bucket", async () => {
  const { now, sleep } = fakeClock()
  // Global grants freely; the catalogue bucket holds one token and refills too
  // slowly for the 2 s budget → the SECOND catalogue call is refused on the API.
  __resetBnfRateLimiterForTests({ ...PROD_RATES, catalogueRpm: 1, now, sleep })
  const first = await acquireBnfMcp("bnf_search_catalogue", {}, undefined)
  assert.deepEqual(first, { ok: true })
  assert.equal(shedOn(await acquireBnfMcp("bnf_search_catalogue", {}, undefined)), BNF_API.CATALOGUE)

  // The Gallica SRU bucket is untouched by the catalogue saturation.
  assert.deepEqual(await acquireBnfMcp("bnf_search_gallica", {}, undefined), { ok: true })
})

test("a saturated global bucket refuses before any API bucket is consulted", async () => {
  const { now, sleep } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, globalRpm: 1, now, sleep })
  assert.deepEqual(await acquireBnfMcp("bnf_search_catalogue", {}, undefined), { ok: true })
  assert.equal(shedOn(await acquireBnfMcp("bnf_search_gallica", {}, undefined)), "global")
})

test("a call shed on its API bucket refunds the global tokens it took", async () => {
  const { now, sleep } = fakeClock()
  // Global 20 rpm → burst 2; catalogue 1 rpm → burst 1. Nothing refills inside
  // the test (the shed never sleeps: its wait exceeds the 2 s budget at once).
  __resetBnfRateLimiterForTests({ ...PROD_RATES, globalRpm: 20, catalogueRpm: 1, now, sleep })
  assert.deepEqual(await acquireBnfMcp("bnf_search_catalogue", {}, undefined), { ok: true }) // global 1 left
  assert.equal(shedOn(await acquireBnfMcp("bnf_search_catalogue", {}, undefined)), BNF_API.CATALOGUE)
  // Without the refund the global bucket would be empty here and Gallica shed.
  assert.deepEqual(await acquireBnfMcp("bnf_search_gallica", {}, undefined), { ok: true })
  assert.equal(shedOn(await acquireBnfMcp("bnf_search_gallica", {}, undefined)), "global")
})

test("a call aborted on its API bucket refunds the global tokens it took", async () => {
  const { now } = fakeClock()
  const sleep = (_ms: number, signal?: AbortSignal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  // Global burst 2; catalogue 60 rpm with a long budget so the second call SLEEPS.
  __resetBnfRateLimiterForTests({ ...PROD_RATES, globalRpm: 20, catalogueRpm: 10, maxWaitMs: 60_000, now, sleep })
  assert.deepEqual(await acquireBnfMcp("bnf_search_catalogue", {}, undefined), { ok: true })
  const controller = new AbortController()
  const pending = acquireBnfMcp("bnf_search_catalogue", {}, controller.signal)
  controller.abort(new Error("turn cancelled"))
  await assert.rejects(pending, /turn cancelled/)
  assert.deepEqual(await acquireBnfMcp("bnf_search_gallica", {}, undefined), { ok: true })
})

test("a BnF 429 freezes the tool's API bucket until Retry-After, the next minute, or the cap", async () => {
  const { now, sleep } = fakeClock()
  const wall = { t: 42_000 } // 18 s before the next clock minute
  const wallClock = () => wall.t
  __resetBnfRateLimiterForTests({ ...PROD_RATES, maxWaitMs: 10_000, now, sleep, wallClock })

  // No Retry-After: frozen to the minute boundary (18 s) > the 10 s budget.
  reportBnfUpstreamRateLimit("bnf_search_catalogue", undefined)
  assert.equal(shedOn(await acquireBnfMcp("bnf_search_catalogue", {}, undefined)), BNF_API.CATALOGUE)
  // Only that API is frozen.
  assert.deepEqual(await acquireBnfMcp("bnf_search_gallica", {}, undefined), { ok: true })

  // Retry-After shorter than the budget: the call waits it out and is granted.
  __resetBnfRateLimiterForTests({ ...PROD_RATES, maxWaitMs: 10_000, now, sleep, wallClock })
  reportBnfUpstreamRateLimit("bnf_get_document_info", 3_000)
  assert.deepEqual(await acquireBnfMcp("bnf_get_document_info", {}, undefined), { ok: true })

  // A garbage Retry-After is capped.
  const { clock: c2, now: now2, sleep: sleep2 } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, maxWaitMs: 60_000, now: now2, sleep: sleep2, wallClock })
  reportBnfUpstreamRateLimit("bnf_sparql_query", 10 * 3_600_000)
  assert.equal(shedOn(await acquireBnfMcp("bnf_sparql_query", {}, undefined)), BNF_API.GRAPHE)
  c2.t += BNF_RATE_LIMIT_FREEZE_MAX_MS
  assert.deepEqual(await acquireBnfMcp("bnf_sparql_query", {}, undefined), { ok: true })
})

test("an input the limiter cannot weigh is refused, not metered", async () => {
  const { now, sleep } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, now, sleep })
  const grant = await acquireBnfMcp("bnf_get_document_text", { max_pages: "150" }, undefined)
  assert.equal(grant.ok === false && grant.kind, "invalid_input")
})

test("the structured refusal names the API and never throws", async () => {
  const { now, sleep } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, catalogueRpm: 1, now, sleep })
  await acquireBnfMcp("bnf_search_catalogue", {}, undefined)
  const refused = await acquireBnfMcp("bnf_search_catalogue", {}, undefined)
  if (refused.ok || refused.kind !== "saturated") throw new Error("expected a saturation")
  const result = quotaSaturatedResult(refused)
  assert.equal(result.success, false)
  assert.equal(result.rate_limited, true)
  assert.equal(result.api, BNF_API.CATALOGUE)
  assert.match(result.error, /Quota BnF saturé/)
  assert.match(result.error, /catalogue/)
  assert.match(result.error, /rien n'a été envoyé/)
  assert.match(result.error, /au moins une minute/)
})

// --- Tool → API map and weights -------------------------------------------

test("every mcp-bnf tool has an API bucket (the incident's Current State table)", () => {
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
  const w = (tool: Parameters<typeof bnfMcpCallWeight>[0], input: Record<string, unknown>) =>
    bnfMcpCallWeight(tool, input)
  assert.deepEqual(w("bnf_search_catalogue", {}), { ok: true, weight: 1 })
  assert.deepEqual(w("bnf_get_document_text", {}), { ok: true, weight: 12 }, "record + pagination + 10 pages")
  assert.deepEqual(w("bnf_get_document_text", { max_pages: 3 }), { ok: true, weight: 5 })
  assert.deepEqual(w("bnf_get_document_text", { max_pages: 5_000 }), { ok: true, weight: 202 }, "clamped to 200")
  assert.deepEqual(w("bnf_get_document_text", { max_pages: 0 }), { ok: true, weight: 3 }, "clamped up to 1")
  assert.deepEqual(w("bnf_find_person", {}), { ok: true, weight: 3 })
  assert.deepEqual(w("bnf_find_work", {}), { ok: true, weight: 2 })
})

test("a non-integer max_pages is refused with a model-readable reason", () => {
  for (const bad of ["150", 2.5, null, Number.NaN]) {
    const weight = bnfMcpCallWeight("bnf_get_document_text", { max_pages: bad })
    assert.equal(weight.ok, false, `max_pages=${String(bad)} must be refused`)
    if (!weight.ok) assert.match(weight.error, /max_pages/)
  }
})

test("isBnfMcpToolName accepts exactly the mapped tools", () => {
  for (const tool of BNF_MCP_TOOLS) assert.equal(isBnfMcpToolName(tool), true)
  assert.equal(isBnfMcpToolName("bnf_some_future_tool"), false)
  assert.equal(isBnfMcpToolName(""), false)
})

test("bnfToolFromPrefixed strips only the bnf server prefix", () => {
  assert.equal(bnfToolFromPrefixed("bnf__bnf_search_catalogue"), "bnf_search_catalogue")
  assert.equal(bnfToolFromPrefixed("bnf__bnf_some_future_tool"), "bnf_some_future_tool")
  assert.equal(bnfToolFromPrefixed("corpus_search"), null)
  assert.equal(bnfToolFromPrefixed("other__bnf_search_catalogue"), null)
  assert.equal(bnfToolFromPrefixed("bnf__"), null)
})
