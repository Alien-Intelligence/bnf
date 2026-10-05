// lib/mcp/rate-limited-registry.test.ts
// The decorator's failure contract. A missing BNF_MCP_RATE_* value must fail
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

// lib/env.ts validates BNF_MCP_RATE_* at import when BNF_MCP_URL is set, so
// the env is cleared BEFORE the decorator (and env.ts behind it) is loaded.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("BNF_MCP_RATE_")) delete process.env[key]
}
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
  assert.throws(() => withBnfRateLimit(stubRegistry([BNF_MCP_SERVER_NAME])), /BNF_MCP_RATE_GLOBAL_RPM/)
})

test("BNF_MCP_URL set fails the build even when MCP discovery dropped the server", () => {
  process.env.BNF_MCP_URL = BNF_MCP_URL ?? "https://bnf.mcp.invalid/mcp"
  try {
    assert.throws(() => withBnfRateLimit(stubRegistry([])), /BNF_MCP_RATE_GLOBAL_RPM/)
  } finally {
    delete process.env.BNF_MCP_URL
  }
})

test("boot: BNF_MCP_URL without the rate env refuses to start; without the URL the env is optional", () => {
  assert.throws(
    () => assertBootBnfRateEnv({ BNF_MCP_URL: "https://bnf.mcp.invalid/mcp" }),
    /BNF_MCP_RATE_GLOBAL_RPM/,
  )
  assert.doesNotThrow(() => assertBootBnfRateEnv({}))
})

test("boot: BNF_MCP_RATE_MAX_WAIT_MS has an upper bound", () => {
  const rates = {
    BNF_MCP_URL: "https://bnf.mcp.invalid/mcp",
    BNF_MCP_RATE_GLOBAL_RPM: "475",
    BNF_MCP_RATE_CATALOGUE_RPM: "47",
    BNF_MCP_RATE_GALLICA_SRU_RPM: "95",
    BNF_MCP_RATE_IIIF_RPM: "285",
    BNF_MCP_RATE_ISSUES_RPM: "47",
    BNF_MCP_RATE_GRAPHE_RPM: "47",
  }
  assert.doesNotThrow(() => assertBootBnfRateEnv({ ...rates, BNF_MCP_RATE_MAX_WAIT_MS: "15000" }))
  assert.throws(
    () => assertBootBnfRateEnv({ ...rates, BNF_MCP_RATE_MAX_WAIT_MS: "3600000" }),
    /BNF_MCP_RATE_MAX_WAIT_MS/,
  )
})

test("without BnF configured the wrap succeeds, and a stray bnf__ call is refused as a result, not a throw", async () => {
  const inner = stubRegistry([])
  const registry = withBnfRateLimit(inner)

  const custom = await registry.dispatch("ask_user", {}, ctx())
  assert.equal(custom.isError, false)

  const raw = await registry.dispatch("bnf__bnf_search_catalogue", { query: "x" }, ctx())
  assert.equal(raw.isError, true)
  assert.match(raw.content, /BNF_MCP_RATE_GLOBAL_RPM/)
  assert.deepEqual(inner.forwarded, ["ask_user"], "the BnF call never reached the registry")
})
