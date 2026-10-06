// lib/mcp/rate-limited-registry.test.ts
// The decorator's failure contract. A missing or invalid BNF_MCP_RATES must fail
// the turn when the registry is BUILT (naming the variable) whenever this
// process can reach BnF — BNF_MCP_URL set, or the BnF server in the registry —
// never throw out of `dispatch` mid-loop (CLAUDE_ERROR_PATTERNS §15), and never
// let a BnF call through unthrottled. Each node:test file runs in its own
// process, so editing the env here does not leak into other suites.
import "server-only"

import { before, test } from "node:test"
import assert from "node:assert/strict"
import type { ToolContext, ToolRegistry } from "@alien/chat-sdk/claude"
import { BNF_MCP_SERVER_NAME } from "./tools"

// lib/env.ts validates BNF_MCP_RATES at import when BNF_MCP_URL is set, so
// the env is cleared BEFORE the decorator (and env.ts behind it) is loaded.
delete process.env.BNF_MCP_RATES
const BNF_MCP_URL = process.env.BNF_MCP_URL
delete process.env.BNF_MCP_URL

let withBnfRateLimit: typeof import("./rate-limited-registry").withBnfRateLimit
let assertBootBnfRateEnv: typeof import("@/lib/env").assertBootBnfRateEnv

before(async () => {
  ;({ withBnfRateLimit } = await import("./rate-limited-registry"))
  ;({ assertBootBnfRateEnv } = await import("@/lib/env"))
})

function stubRegistry(mcpServerNames: string[]): ToolRegistry & { forwarded: string[] } {
  const forwarded: string[] = []
  return {
    forwarded,
    customTools: [],
    mcpServers: mcpServerNames.map((name) => ({ name, url: "http://mcp.invalid/mcp" })),
    resolve: async () => [],
    async dispatch(toolName) {
      forwarded.push(toolName)
      return { isError: false, content: "{}" }
    },
  }
}

function ctx(): ToolContext {
  return { signal: new AbortController().signal, request: new Request("http://localhost/test") }
}

test("a registry carrying the BnF server fails at build time when the rate env is missing", () => {
  assert.throws(() => withBnfRateLimit(stubRegistry([BNF_MCP_SERVER_NAME])), /BNF_MCP_RATES is not set/)
})

test("BNF_MCP_URL set fails the build even when MCP discovery dropped the server", () => {
  process.env.BNF_MCP_URL = BNF_MCP_URL ?? "https://bnf.mcp.invalid/mcp"
  try {
    assert.throws(() => withBnfRateLimit(stubRegistry([])), /BNF_MCP_RATES is not set/)
  } finally {
    delete process.env.BNF_MCP_URL
  }
})

test("boot: BNF_MCP_URL without the rate env refuses to start; without the URL the env is optional", () => {
  assert.throws(
    () => assertBootBnfRateEnv({ BNF_MCP_URL: "https://bnf.mcp.invalid/mcp" }),
    /BNF_MCP_RATES is not set/,
  )
  assert.doesNotThrow(() => assertBootBnfRateEnv({}))
})

const URL_SET = { BNF_MCP_URL: "https://bnf.mcp.invalid/mcp" }
const RATES = {
  globalRpm: 475,
  catalogueRpm: 47,
  gallicaSruRpm: 95,
  iiifRpm: 285,
  issuesRpm: 47,
  grapheRpm: 47,
  maxWaitMs: 15000,
}
const withRates = (rates: unknown) => ({ ...URL_SET, BNF_MCP_RATES: JSON.stringify(rates) })

test("boot: one JSON object carries every rate, and maxWaitMs has an upper bound", () => {
  assert.doesNotThrow(() => assertBootBnfRateEnv(withRates(RATES)))
  assert.throws(() => assertBootBnfRateEnv(withRates({ ...RATES, maxWaitMs: 3_600_000 })), /maxWaitMs/)
})

test("boot: a missing, unknown, non-integer or non-JSON rate is refused, naming it", () => {
  const { grapheRpm: _dropped, ...missing } = RATES
  assert.throws(() => assertBootBnfRateEnv(withRates(missing)), /grapheRpm/)
  assert.throws(() => assertBootBnfRateEnv(withRates({ ...RATES, catalogRpm: 47 })), /catalogRpm/)
  assert.throws(() => assertBootBnfRateEnv(withRates({ ...RATES, iiifRpm: 28.5 })), /iiifRpm/)
  assert.throws(() => assertBootBnfRateEnv(withRates({ ...RATES, iiifRpm: "285" })), /iiifRpm/)
  assert.throws(() => assertBootBnfRateEnv({ ...URL_SET, BNF_MCP_RATES: "globalRpm=475" }), /not valid JSON/)
})

test("without BnF configured the wrap succeeds, and a stray bnf__ call is refused as a result, not a throw", async () => {
  const inner = stubRegistry([])
  const registry = withBnfRateLimit(inner)

  const custom = await registry.dispatch("ask_user", {}, ctx())
  assert.equal(custom.isError, false)

  const raw = await registry.dispatch("bnf__bnf_search_catalogue", { query: "x" }, ctx())
  assert.equal(raw.isError, true)
  assert.match(raw.content, /BNF_MCP_RATES is not set/)
  assert.deepEqual(inner.forwarded, ["ask_user"], "the BnF call never reached the registry")
})
