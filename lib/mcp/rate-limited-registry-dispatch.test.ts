// lib/mcp/rate-limited-registry-dispatch.test.ts
// What the decorator does with each `bnf__` call once the limiter is
// configured: unknown tools and unmeterable inputs are REFUSED with a
// model-readable result (never metered on the global bucket alone, never
// sent), and a 429 in the dispatched result — the SDK's transport error or
// mcp-bnf's soft envelope — freezes the tool's API bucket for every agent.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import type { ToolContext, ToolDispatchResult, ToolRegistry } from "@alien/chat-sdk/claude"
import { __resetBnfRateLimiterForTests } from "./rate-limit"
import { withBnfRateLimit } from "./rate-limited-registry"
import { BNF_MCP_SERVER_NAME } from "./tools"

const RATES = {
  globalRpm: 475,
  catalogueRpm: 47,
  gallicaSruRpm: 95,
  iiifRpm: 285,
  issuesRpm: 47,
  grapheRpm: 47,
  maxWaitMs: 1_000,
  wallClock: () => 0, // a 429 without Retry-After freezes for a full minute
}

function stubRegistry(answer: ToolDispatchResult): ToolRegistry & { forwarded: string[] } {
  const forwarded: string[] = []
  return {
    forwarded,
    customTools: [],
    mcpServers: [{ name: BNF_MCP_SERVER_NAME, url: "http://mcp.invalid/mcp" }],
    resolve: async () => [],
    async dispatch(toolName) {
      forwarded.push(toolName)
      return answer
    },
  }
}

function ctx(): ToolContext {
  return { signal: new AbortController().signal, request: new Request("http://localhost/test") }
}

test("an unmapped bnf__ tool is refused with a model-readable result and never sent", async () => {
  __resetBnfRateLimiterForTests(RATES)
  const inner = stubRegistry({ isError: false, content: "{}" })
  const result = await withBnfRateLimit(inner).dispatch("bnf__bnf_some_future_tool", {}, ctx())
  assert.equal(result.isError, true)
  assert.match(result.content, /"success":false/)
  assert.match(result.content, /"refused":"bnf_call_refused"/)
  assert.match(result.content, /bnf_search_catalogue/, "lists the tools that do exist")
  assert.deepEqual(inner.forwarded, [])
})

test("a bare bnf__ (no tool name) is refused like any unknown tool, never sent", async () => {
  __resetBnfRateLimiterForTests(RATES)
  const inner = stubRegistry({ isError: false, content: "{}" })
  const result = await withBnfRateLimit(inner).dispatch("bnf__", {}, ctx())
  assert.equal(result.isError, true)
  assert.match(result.content, /"refused":"bnf_call_refused"/)
  assert.deepEqual(inner.forwarded, [])
})

test("a non-integer max_pages is refused and never sent", async () => {
  __resetBnfRateLimiterForTests(RATES)
  const inner = stubRegistry({ isError: false, content: "{}" })
  const result = await withBnfRateLimit(inner).dispatch(
    "bnf__bnf_get_document_text",
    { ark: "ark:/12148/bpt6k1", max_pages: "150" },
    ctx(),
  )
  assert.equal(result.isError, true)
  assert.match(result.content, /max_pages/)
  assert.deepEqual(inner.forwarded, [])
})

for (const [label, answer] of [
  ["mcp-bnf's soft 429 envelope", { isError: false, content: JSON.stringify({ success: false, status_code: 429, error: "HTTP 429" }) }],
  ["the SDK's HTTP 429 transport error", { isError: true, content: "MCP bnf tools/call HTTP 429: Too Many Requests" }],
] as const) {
  test(`${label} freezes the API bucket: the next call to that API is shed`, async () => {
    __resetBnfRateLimiterForTests(RATES)
    const inner = stubRegistry(answer)
    const registry = withBnfRateLimit(inner)
    await registry.dispatch("bnf__bnf_search_catalogue", { query: "a" }, ctx())
    const shed = await registry.dispatch("bnf__bnf_get_catalogue_record", { ark: "x" }, ctx())
    assert.equal(shed.isError, true)
    assert.match(shed.content, /"rate_limited":true/)
    assert.match(shed.content, /"api":"catalogue"/)
    // Another API is not frozen.
    await registry.dispatch("bnf__bnf_search_gallica", { query: "a" }, ctx())
    assert.deepEqual(inner.forwarded, ["bnf__bnf_search_catalogue", "bnf__bnf_search_gallica"])
  })
}
