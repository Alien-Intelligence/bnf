// lib/mcp/rate-limited-registry.test.ts
// The decorator's failure contract. A missing BNF_MCP_RATE_* value must fail
// the turn when the registry is BUILT (naming the variable), never throw out
// of `dispatch` mid-loop (CLAUDE_ERROR_PATTERNS §15) — and never let a BnF
// call through unthrottled. Each node:test file runs in its own process, so
// deleting the env here does not leak into other suites.
import "server-only"

for (const key of Object.keys(process.env)) {
  if (key.startsWith("BNF_MCP_RATE_")) delete process.env[key]
}

import { test } from "node:test"
import assert from "node:assert/strict"
import type { ToolContext, ToolRegistry } from "@alien/chat-sdk/claude"
import { withBnfRateLimit } from "./rate-limited-registry"
import { BNF_MCP_SERVER_NAME } from "./tools"

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
  assert.throws(
    () => withBnfRateLimit(stubRegistry([BNF_MCP_SERVER_NAME])),
    /BNF_MCP_RATE_GLOBAL_RPM/,
  )
})

test("without the BnF server the wrap succeeds, and a stray bnf__ call is refused as a result, not a throw", async () => {
  const inner = stubRegistry([])
  const registry = withBnfRateLimit(inner)

  const custom = await registry.dispatch("ask_user", {}, ctx())
  assert.equal(custom.isError, false)

  const raw = await registry.dispatch("bnf__bnf_search_catalogue", { query: "x" }, ctx())
  assert.equal(raw.isError, true)
  assert.match(raw.content, /BNF_MCP_RATE_GLOBAL_RPM/)
  assert.deepEqual(inner.forwarded, ["ask_user"], "the BnF call never reached the registry")
})
