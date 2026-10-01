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
  acquireBnfMcp,
  bnfMcpCallWeight,
  bucketBurst,
  quotaSaturatedResult,
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

test("acquireBnfMcp takes the global bucket first, then the API bucket", async () => {
  const { now, sleep } = fakeClock()
  // Global grants freely; the catalogue bucket holds one token and refills too
  // slowly for the 2 s budget → the SECOND catalogue call is refused on the API.
  __resetBnfRateLimiterForTests({ ...PROD_RATES, catalogueRpm: 1, now, sleep })
  const first = await acquireBnfMcp("bnf_search_catalogue", {}, undefined)
  assert.deepEqual(first, { ok: true })
  const second = await acquireBnfMcp("bnf_search_catalogue", {}, undefined)
  assert.equal(second.ok, false)
  assert.equal(second.ok === false && second.api, BNF_API.CATALOGUE)

  // The Gallica SRU bucket is untouched by the catalogue saturation.
  assert.deepEqual(await acquireBnfMcp("bnf_search_gallica", {}, undefined), { ok: true })
})

test("a saturated global bucket refuses before any API bucket is consulted", async () => {
  const { now, sleep } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, globalRpm: 1, now, sleep })
  assert.deepEqual(await acquireBnfMcp("bnf_search_catalogue", {}, undefined), { ok: true })
  const refused = await acquireBnfMcp("bnf_search_gallica", {}, undefined)
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false && refused.api, "global")
})

test("an unmapped bnf_* tool is charged to the global bucket only", async () => {
  const { now, sleep } = fakeClock()
  // 20 rpm → burst 2: two immediate grants, the third needs a 3 s refill > the 2 s budget.
  __resetBnfRateLimiterForTests({ ...PROD_RATES, globalRpm: 20, now, sleep })
  assert.deepEqual(await acquireBnfMcp("bnf_some_future_tool", {}, undefined), { ok: true })
  assert.deepEqual(await acquireBnfMcp("bnf_some_future_tool", {}, undefined), { ok: true })
  const refused = await acquireBnfMcp("bnf_some_future_tool", {}, undefined)
  assert.equal(refused.ok === false && refused.api, "global")
})

test("the structured refusal names the API and never throws", async () => {
  const { now, sleep } = fakeClock()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, catalogueRpm: 1, now, sleep })
  await acquireBnfMcp("bnf_search_catalogue", {}, undefined)
  const refused = await acquireBnfMcp("bnf_search_catalogue", {}, undefined)
  assert.equal(refused.ok, false)
  if (refused.ok) return
  const result = quotaSaturatedResult(refused)
  assert.equal(result.success, false)
  assert.equal(result.rate_limited, true)
  assert.equal(result.api, BNF_API.CATALOGUE)
  assert.match(result.error, /Quota BnF saturé/)
  assert.match(result.error, /catalogue/)
  assert.match(result.error, /rien n'a été envoyé/)
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
  assert.equal(bnfMcpCallWeight("bnf_search_catalogue", {}), 1)
  assert.equal(bnfMcpCallWeight("bnf_get_document_text", {}), 11, "manifest + 10 default pages")
  assert.equal(bnfMcpCallWeight("bnf_get_document_text", { max_pages: 3 }), 4)
  assert.equal(bnfMcpCallWeight("bnf_get_document_text", { max_pages: 5_000 }), 201, "clamped to 200 pages")
  assert.equal(bnfMcpCallWeight("bnf_get_document_text", { max_pages: 0 }), 2, "clamped up to 1 page")
  assert.equal(bnfMcpCallWeight("bnf_find_person", {}), 3)
  assert.equal(bnfMcpCallWeight("bnf_find_work", {}), 2)
})

test("bnfToolFromPrefixed strips only the bnf server prefix", () => {
  assert.equal(bnfToolFromPrefixed("bnf__bnf_search_catalogue"), "bnf_search_catalogue")
  assert.equal(bnfToolFromPrefixed("bnf__bnf_some_future_tool"), "bnf_some_future_tool")
  assert.equal(bnfToolFromPrefixed("corpus_search"), null)
  assert.equal(bnfToolFromPrefixed("other__bnf_search_catalogue"), null)
  assert.equal(bnfToolFromPrefixed("bnf__"), null)
})
