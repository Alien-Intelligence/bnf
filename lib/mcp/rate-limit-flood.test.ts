// lib/mcp/rate-limit-flood.test.ts
// The 2026-09-30 incident, replayed: one parent plus 7 spawn_research children
// (session b275569f…) hammering bnf_search_catalogue back to back for minutes.
// On main every call reached BnF — 2 548 catalogue calls in 2.5 h against a
// 100/min quota, 346 × 429 and 252 × 500 on connector 46. Both enforcement
// points (the registry decorator for SDK-dispatched raw tools and callBnfTool
// for app-made calls) share one process-wide set of limiters, so the forwarded
// rate can never exceed the configured rate whatever the fan-out. The agents run
// CONCURRENTLY on a virtual scheduler, and the per-API and GLOBAL sliding-window
// peaks of the SENT calls are measured.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import type { ToolContext, ToolRegistry } from "@alien/chat-sdk/claude"
import { callBnfTool } from "./call"
import { BnfMcpQuotaSaturatedError } from "./errors"
import { withBnfRateLimit } from "./rate-limited-registry"
import { BNF_API, BNF_MCP_TOOL_API, __resetBnfRateLimiterForTests, isBnfMcpToolName } from "./rate-limit"
import { bnfToolFromPrefixed } from "./tools"

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

/** A raw (undecorated) registry recording the (fake) time of every call. */
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

/**
 * A virtual scheduler: every sleep (the limiter's and the agents' think time)
 * registers a timer on a virtual clock; the driver lets every runnable agent
 * settle, then jumps the clock to the next timer. The agents run CONCURRENTLY
 * — their acquires interleave in the limiters' FIFO queues exactly as they
 * would in production — and no test waits on real time.
 */
class VirtualScheduler {
  t = 0
  private timers: Array<{ at: number; resolve: () => void }> = []
  readonly now = () => this.t
  readonly sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const timer = { at: this.t + Math.max(0, ms), resolve }
      this.timers.push(timer)
      signal?.addEventListener(
        "abort",
        () => {
          this.timers = this.timers.filter((x) => x !== timer)
          reject(signal.reason)
        },
        { once: true },
      )
    })

  /** Drive until `work` settles. */
  async run(work: Promise<unknown>): Promise<void> {
    let finished = false
    const done = work.finally(() => {
      finished = true
    })
    for (;;) {
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
      if (finished) break
      if (this.timers.length === 0) throw new Error("virtual scheduler: agents pending with no timer (deadlock)")
      const next = Math.min(...this.timers.map((x) => x.at))
      this.t = Math.max(this.t, next)
      const due = this.timers.filter((x) => x.at <= this.t)
      this.timers = this.timers.filter((x) => x.at > this.t)
      for (const x of due) x.resolve()
    }
    await done
  }
}

type Send = { at: number; weight: number; api: string }

/** A stub registry whose dispatch records the (virtual) send time of every forwarded call. */
function recordingRegistry(sent: Send[], now: () => number, weightOf: (id: string) => number) {
  return withBnfRateLimit({
    customTools: [],
    mcpServers: [],
    resolve: async () => [],
    dispatch: async (name, _input, _ctx, toolUseId) => {
      sent.push({ at: now(), weight: weightOf(toolUseId ?? ""), api: apiOf(name) })
      return { content: JSON.stringify({ success: true }), isError: false }
    },
  })
}

function apiOf(prefixed: string): string {
  const raw = bnfToolFromPrefixed(prefixed)
  if (raw === null || !isBnfMcpToolName(raw)) throw new Error(`not a metered BnF tool: ${prefixed}`)
  return BNF_MCP_TOOL_API[raw]
}

const byApi = (sent: Send[], api: string) => sent.filter((e) => e.api === api)

test("8 CONCURRENT agents flooding the catalogue stay under quota × 0.95, across both enforcement points", async () => {
  const sched = new VirtualScheduler()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, now: sched.now, sleep: sched.sleep })
  const sent: Send[] = []
  const limited = recordingRegistry(sent, sched.now, () => 1)
  const realFetch = globalThis.fetch
  const fetched: number[] = []
  globalThis.fetch = stubFetch(fetched, sched.now)

  let refused = 0
  let attempts = 0
  const agent = async (id: number) => {
    let iteration = 0
    while (sched.t < SIMULATED_MS) {
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
        const result = await limited.dispatch("bnf__bnf_search_catalogue", { query: "coiffure" }, ctx(), `a${id}_${iteration}`)
        if (result.isError) {
          assert.match(result.content, /"rate_limited":true/, "the only error the stub can produce is a refusal")
          refused += 1
        }
      }
      await sched.sleep(THINK_MS)
    }
  }
  try {
    await sched.run(Promise.all(Array.from({ length: AGENTS }, (_, i) => agent(i))))
  } finally {
    globalThis.fetch = realFetch
  }

  const all = [...sent, ...fetched.map((at) => ({ at, weight: 1, api: BNF_API.CATALOGUE }))]
  const expected = (SIMULATED_MS / 60_000) * PROD_RATES.catalogueRpm
  assert.ok(attempts > expected * 2, `the flood was real: ${attempts} attempts for ${expected} grants`)
  assert.ok(refused > 0, "saturation produced structured refusals")
  assert.ok(fetched.length > 0 && sent.length > 0, "both enforcement points sent calls")
  const peak = peakPerMinute(all)
  assert.ok(peak <= CATALOGUE_QUOTA * QUOTA_SHARE, `catalogue sliding-window peak ${peak}/min ≤ ${CATALOGUE_QUOTA * QUOTA_SHARE}`)
  assert.ok(all.length >= expected - PROD_RATES.catalogueRpm, `the limiter still lets the quota through (${all.length})`)
})

test("8 CONCURRENT agents on two APIs: per-API AND global peaks hold while calls wait a minute on their API", async () => {
  // The global limit binds below the sum of the two APIs, and a 60 s wait
  // budget lets a call hold its global grant for a whole window while it waits
  // on its API — the case where a grant-stamped global ticket would age out.
  const RATES = { ...PROD_RATES, globalRpm: 10, catalogueRpm: 2, iiifRpm: 10, maxWaitMs: 60_000 }
  const sched = new VirtualScheduler()
  __resetBnfRateLimiterForTests({ ...RATES, now: sched.now, sleep: sched.sleep })
  const sent: Send[] = []
  const limited = recordingRegistry(sent, sched.now, () => 1)
  const agent = async (id: number) => {
    let iteration = 0
    // Four agents pile up on the tight catalogue, a call every 15 s each —
    // each holds its global grant while it waits up to a minute for the API;
    // four keep the global limiter saturated through IIIF page reads.
    const catalogue = id < 4
    while (sched.t < SIMULATED_MS) {
      iteration += 1
      const tool = catalogue ? "bnf__bnf_search_catalogue" : "bnf__bnf_get_page_text"
      await limited.dispatch(tool, { query: "coiffure", ark: "x" }, ctx(), `a${id}_${iteration}`)
      await sched.sleep(catalogue ? 15_000 : THINK_MS)
    }
  }
  await sched.run(Promise.all(Array.from({ length: AGENTS }, (_, i) => agent(i))))

  const catalogue = peakPerMinute(byApi(sent, BNF_API.CATALOGUE))
  const iiif = peakPerMinute(byApi(sent, BNF_API.IIIF))
  const global = peakPerMinute(sent)
  assert.ok(catalogue <= RATES.catalogueRpm, `catalogue peak ${catalogue} ≤ ${RATES.catalogueRpm}`)
  assert.ok(iiif <= RATES.iiifRpm, `IIIF peak ${iiif} ≤ ${RATES.iiifRpm}`)
  assert.ok(global <= RATES.globalRpm, `GLOBAL peak ${global} ≤ ${RATES.globalRpm}`)
  assert.equal(global, RATES.globalRpm, "the global limit is the binding one")
})

test("8 CONCURRENT agents with heavy full-text reads stay under the IIIF quota × 0.95 by WEIGHT", async () => {
  const sched = new VirtualScheduler()
  __resetBnfRateLimiterForTests({ ...PROD_RATES, now: sched.now, sleep: sched.sleep })
  const sent: Send[] = []
  const weights = new Map<string, number>()
  const limited = recordingRegistry(sent, sched.now, (id) => weights.get(id) ?? 0)
  const agent = async (id: number) => {
    let iteration = 0
    while (sched.t < SIMULATED_MS) {
      iteration += 1
      const key = `a${id}_${iteration}`
      // Alternate a 202-request full-text read (200 pages) with single page reads.
      const heavy = (id + iteration) % 2 === 0
      weights.set(key, heavy ? 202 : 1)
      await limited.dispatch(
        heavy ? "bnf__bnf_get_document_text" : "bnf__bnf_get_page_text",
        heavy ? { ark: "x", max_pages: 200 } : { ark: "x" },
        ctx(),
        key,
      )
      await sched.sleep(THINK_MS)
    }
  }
  await sched.run(Promise.all(Array.from({ length: AGENTS }, (_, i) => agent(i))))
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
