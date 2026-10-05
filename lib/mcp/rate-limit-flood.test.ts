// lib/mcp/rate-limit-flood.test.ts
// The 2026-09-30 incident, replayed: one parent plus 7 spawn_research children
// (session b275569f…) hammering bnf_search_catalogue back to back for minutes.
// On main every call reached BnF — 2 548 catalogue calls in 2.5 h against a
// 100/min quota, 346 × 429 and 252 × 500 on connector 46. Both enforcement
// points (the registry decorator for SDK-dispatched raw tools and callBnfTool
// for app-made calls) share one process-wide set of limiters, so the forwarded
// rate can never exceed the configured catalogue rate whatever the fan-out.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import type { ToolContext, ToolRegistry } from "@alien/chat-sdk/claude"
import { callBnfTool } from "./call"
import { BnfMcpQuotaSaturatedError } from "./errors"
import { withBnfRateLimit } from "./rate-limited-registry"
import { __resetBnfRateLimiterForTests } from "./rate-limit"

const PROD_RATES = {
  globalRpm: 475,
  catalogueRpm: 47,
  gallicaSruRpm: 95,
  iiifRpm: 285,
  issuesRpm: 47,
  grapheRpm: 47,
  maxWaitMs: 2_000,
}
const SIMULATED_MS = 5 * 60_000
/** Model latency between two consecutive calls of one agent loop. */
const THINK_MS = 250
const AGENTS = 8 // the parent + 7 children

/** A stub registry whose dispatch records the (fake) time of every forwarded call. */
function stubRegistry(forwarded: number[], now: () => number): ToolRegistry<ToolContext> {
  return {
    customTools: [],
    mcpServers: [],
    resolve: async () => [],
    dispatch: async () => {
      forwarded.push(now())
      return { content: JSON.stringify({ success: true }), isError: false }
    },
  }
}

/** A stubbed MCP transport for callBnfTool: records the call, answers one empty page. */
function stubFetch(forwarded: number[], now: () => number): typeof fetch {
  return async () => {
    forwarded.push(now())
    const payload = {
      pagination: { total: 0, count: 0, has_more: false, start_record: 1 },
      data: { records: [] },
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
}

function ctx(): ToolContext {
  return { signal: new AbortController().signal, request: new Request("http://localhost/test") }
}

/** The interface key's catalogue quota (CATALOGUESERVICE-CONS: 50/min). */
const CATALOGUE_QUOTA = 50
/** The share of a quota the limiter may use (helm values: quotas × 0.95). */
const QUOTA_SHARE = 0.95
/** Gallica-IIIF quota (300/min). */
const IIIF_QUOTA = 300

/** Max total weight falling in any 60 s sliding window. */
function peakPerMinute(events: Array<{ at: number; weight: number }>): number {
  const sorted = [...events].sort((a, b) => a.at - b.at)
  let peak = 0
  let sum = 0
  let lo = 0
  for (let hi = 0; hi < sorted.length; hi++) {
    sum += sorted[hi].weight
    while (sorted[hi].at - sorted[lo].at >= 60_000) sum -= sorted[lo++].weight
    peak = Math.max(peak, sum)
  }
  return peak
}

const unit = (times: number[]) => times.map((at) => ({ at, weight: 1 }))

test("8 agents flooding the catalogue cannot exceed 47/min across both enforcement points", async () => {
  const clock = { t: 0 }
  const now = () => clock.t
  __resetBnfRateLimiterForTests({
    ...PROD_RATES,
    now,
    sleep: async (ms) => {
      clock.t += ms
    },
  })

  const forwarded: number[] = []
  const limited = withBnfRateLimit(stubRegistry(forwarded, now))
  const realFetch = globalThis.fetch
  globalThis.fetch = stubFetch(forwarded, now)

  let refused = 0
  let attempts = 0
  try {
    // Round-robin: each agent's call is awaited to completion before the
    // next, so the fake clock only moves inside the limiter's own wait (or by
    // the think time between rounds) and every recorded send time IS its grant
    // time — the sliding-window measure below is exact, not skewed by another
    // agent advancing the shared clock mid-dispatch.
    const call = async (iteration: number) => {
      attempts += 1
      if (iteration % 3 === 0) {
        // The app-made path: corpus_search → callBnfTool.
        try {
          await callBnfTool("http://mcp.test/mcp", "token", "bnf_search_catalogue", {
            response_format: "json",
            query: "coiffure",
          })
        } catch (err) {
          if (!(err instanceof BnfMcpQuotaSaturatedError)) throw err
          refused += 1
        }
        return
      }
      // The SDK-dispatched raw tool: the model calling bnf__bnf_search_catalogue.
      const result = await limited.dispatch("bnf__bnf_search_catalogue", { query: "coiffure" }, ctx(), `tu_${iteration}`)
      if (result.isError) {
        assert.match(result.content, /"rate_limited":true/, "the only error the stub can produce is a refusal")
        refused += 1
      }
    }
    let iteration = 0
    while (clock.t < SIMULATED_MS) {
      for (let agent = 0; agent < AGENTS; agent++) await call(++iteration)
      clock.t += THINK_MS
    }
  } finally {
    globalThis.fetch = realFetch
  }

  const expected = (SIMULATED_MS / 60_000) * PROD_RATES.catalogueRpm
  assert.ok(attempts > expected * 2, `the flood was real: ${attempts} attempts for ${expected} grants`)
  assert.ok(refused > 0, "saturation produced structured refusals")
  const peak = peakPerMinute(unit(forwarded))
  assert.ok(
    peak <= CATALOGUE_QUOTA * QUOTA_SHARE,
    `sliding-window peak ${peak}/min ≤ quota × 0.95 = ${CATALOGUE_QUOTA * QUOTA_SHARE}`,
  )
  const span = Math.max(...forwarded)
  const windows = Math.floor(span / 60_000) + 1
  assert.ok(
    forwarded.length <= windows * PROD_RATES.catalogueRpm,
    `forwarded ${forwarded.length} ≤ ${windows} windows × ${PROD_RATES.catalogueRpm}`,
  )
  assert.ok(forwarded.length >= expected - PROD_RATES.catalogueRpm, "the limiter still lets the quota through")
})

test("heavy full-text reads on IIIF stay under quota × 0.95 by WEIGHT in every 60 s window", async () => {
  const clock = { t: 0 }
  const now = () => clock.t
  __resetBnfRateLimiterForTests({
    ...PROD_RATES,
    now,
    sleep: async (ms) => {
      clock.t += ms
    },
  })
  const sent: Array<{ at: number; weight: number }> = []
  const weights = new Map<string, number>()
  const limited = withBnfRateLimit({
    customTools: [],
    mcpServers: [],
    resolve: async () => [],
    dispatch: async (_name, _input, _ctx, toolUseId) => {
      sent.push({ at: now(), weight: weights.get(toolUseId ?? "") ?? 0 })
      return { content: JSON.stringify({ success: true }), isError: false }
    },
  })
  let i = 0
  while (clock.t < SIMULATED_MS) {
    for (let agent = 0; agent < AGENTS; agent++) {
      i += 1
      const id = `a${agent}_${i}`
      // Alternate a 202-request full-text read (200 pages) with single page reads.
      const heavy = i % 2 === 0
      weights.set(id, heavy ? 202 : 1)
      await limited.dispatch(
        heavy ? "bnf__bnf_get_document_text" : "bnf__bnf_get_page_text",
        heavy ? { ark: "x", max_pages: 200 } : { ark: "x" },
        ctx(),
        id,
      )
    }
    clock.t += THINK_MS
  }
  const peak = peakPerMinute(sent)
  assert.ok(sent.some((e) => e.weight === 202), "heavy calls were granted at all")
  assert.ok(peak <= IIIF_QUOTA * QUOTA_SHARE, `weighted IIIF peak ${peak}/min ≤ ${IIIF_QUOTA * QUOTA_SHARE}`)
})

test("positive control: without the decorator the stub sees every call (the incident)", async () => {
  const clock = { t: 0 }
  const now = () => clock.t
  const forwarded: number[] = []
  const raw = stubRegistry(forwarded, now)
  let attempts = 0
  const loop = async () => {
    while (clock.t < SIMULATED_MS) {
      attempts += 1
      await raw.dispatch("bnf__bnf_search_catalogue", { query: "coiffure" }, ctx(), "tu")
      clock.t += THINK_MS
    }
  }
  await Promise.all(Array.from({ length: AGENTS }, () => loop()))
  assert.equal(forwarded.length, attempts)
  assert.ok(
    peakPerMinute(unit(forwarded)) > CATALOGUE_QUOTA,
    "unthrottled, the per-minute peak blows through the quota",
  )
})
