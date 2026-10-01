// lib/mcp/rate-limit-flood.test.ts
// The 2026-09-30 incident, replayed: one parent plus 7 spawn_research children
// (session b275569f…) hammering bnf_search_catalogue back to back for minutes.
// On main every call reached BnF — 2 548 catalogue calls in 2.5 h against a
// 100/min quota, 346 × 429 and 252 × 500 on connector 46. Both enforcement
// points (the registry decorator for SDK-dispatched raw tools and callBnfTool
// for app-made calls) share one process-wide set of buckets, so the forwarded
// rate can never exceed the configured catalogue rate whatever the fan-out.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import type { ToolContext, ToolRegistry } from "@alien/chat-sdk/claude"
import { callBnfTool } from "./call"
import { BnfMcpQuotaSaturatedError } from "./errors"
import { withBnfRateLimit } from "./rate-limited-registry"
import { __resetBnfRateLimiterForTests, bucketBurst } from "./rate-limit"

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

/** Max number of timestamps falling in any 60 s window. */
function peakPerMinute(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b)
  let peak = 0
  let lo = 0
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi] - sorted[lo] >= 60_000) lo++
    peak = Math.max(peak, hi - lo + 1)
  }
  return peak
}

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
  const burst = bucketBurst(PROD_RATES.catalogueRpm)

  const forwarded: number[] = []
  const limited = withBnfRateLimit(stubRegistry(forwarded, now))
  const realFetch = globalThis.fetch
  globalThis.fetch = stubFetch(forwarded, now)

  let refused = 0
  let attempts = 0
  try {
    const loop = async () => {
      let iteration = 0
      while (clock.t < SIMULATED_MS) {
        iteration += 1
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
        } else {
          // The SDK-dispatched raw tool: the model calling bnf__bnf_search_catalogue.
          const result = await limited.dispatch(
            "bnf__bnf_search_catalogue",
            { query: "coiffure" },
            ctx(),
            `tu_${iteration}`,
          )
          if (result.isError) {
            const parsed = JSON.parse(result.content) as { rate_limited?: boolean }
            assert.equal(parsed.rate_limited, true, "the only error the stub can produce is a refusal")
            refused += 1
          }
        }
        clock.t += THINK_MS
      }
    }
    await Promise.all(Array.from({ length: AGENTS }, () => loop()))
  } finally {
    globalThis.fetch = realFetch
  }

  const expected = (SIMULATED_MS / 60_000) * PROD_RATES.catalogueRpm + burst
  assert.ok(attempts > expected * 2, `the flood was real: ${attempts} attempts for ${expected} tokens`)
  assert.ok(refused > 0, "saturation produced structured refusals")
  assert.ok(
    peakPerMinute(forwarded) <= PROD_RATES.catalogueRpm + burst,
    `peak ${peakPerMinute(forwarded)}/min ≤ ${PROD_RATES.catalogueRpm + burst}`,
  )
  assert.ok(
    Math.abs(forwarded.length - expected) <= 1,
    `forwarded ${forwarded.length} ≈ ${expected} (5 min × 47 + burst)`,
  )
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
    peakPerMinute(forwarded) > PROD_RATES.catalogueRpm + bucketBurst(PROD_RATES.catalogueRpm),
    "unthrottled, the per-minute peak blows through the quota",
  )
})
