// lib/mcp/rate-limited-registry-runner.test.ts
// Decision 17 of the Track E plan, proved on the SDK's REAL dispatch path:
// `runClaudeSdk` (the direct-Anthropic runner) against a local fake Anthropic
// streaming endpoint, with the real `createToolRegistry` talking to a local
// fake mcp-bnf. The model asks for three BnF calls in one turn; the decorator
// must sit between the runner and the MCP transport so that
//   1. the first catalogue call reaches the MCP, which answers mcp-bnf's
//      soft 429 envelope → the catalogue bucket is frozen;
//   2. the second catalogue call is shed by that freeze and never sent;
//   3. a `bnf__` tool the limiter does not know is refused and never sent.
// No real network: both servers listen on 127.0.0.1, Langfuse is disabled.
import "server-only"

for (const key of Object.keys(process.env)) {
  if (key.startsWith("LANGFUSE_")) delete process.env[key]
}

import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { createToolRegistry, runClaudeSdk } from "@alien/chat-sdk/claude"
import { __resetBnfRateLimiterForTests } from "./rate-limit"
import { withBnfRateLimit } from "./rate-limited-registry"
import { BNF_MCP_SERVER_NAME, bnfPrefixedToolName } from "./tools"

/** Generous rates: only the 429 freeze can shed the second catalogue call. */
const RATES = {
  globalRpm: 475,
  catalogueRpm: 47,
  gallicaSruRpm: 95,
  iiifRpm: 285,
  issuesRpm: 47,
  grapheRpm: 47,
  maxWaitMs: 1_000,
  // Wall clock pinned to a minute boundary: a 429 without Retry-After freezes
  // the bucket for a full 60 s, far beyond the 1 s budget.
  wallClock: () => 0,
}

const UNKNOWN_BNF_TOOL = `${BNF_MCP_SERVER_NAME}__bnf_some_future_tool`

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("expected a TCP address")
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
}

function sse(events: Array<Record<string, unknown> & { type: string }>): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")
}

const USAGE = { input_tokens: 1, output_tokens: 1 }

function messageStart(id: string) {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-test",
      stop_reason: null,
      stop_sequence: null,
      usage: USAGE,
    },
  }
}

function toolUseBlock(index: number, id: string, name: string, input: Record<string, unknown>) {
  return [
    { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index },
  ]
}

/** Turn 1: three tool calls. Turn 2: a closing text. */
function fakeAnthropic(requests: unknown[]): Server {
  return createServer((req, res) => {
    void readBody(req).then((body) => {
      requests.push(JSON.parse(body))
      res.writeHead(200, { "content-type": "text/event-stream" })
      if (requests.length === 1) {
        const catalogue = bnfPrefixedToolName("bnf_search_catalogue")
        res.end(
          sse([
            messageStart("msg_1"),
            ...toolUseBlock(0, "toolu_1", catalogue, { query: "bib.title all \"Le Temps\"" }),
            ...toolUseBlock(1, "toolu_2", catalogue, { query: "bib.title all \"Le Figaro\"" }),
            ...toolUseBlock(2, "toolu_3", UNKNOWN_BNF_TOOL, {}),
            { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: USAGE },
            { type: "message_stop" },
          ]),
        )
        return
      }
      res.end(
        sse([
          messageStart("msg_2"),
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fini" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: USAGE },
          { type: "message_stop" },
        ]),
      )
    })
  })
}

/** mcp-bnf stand-in: lists one tool; every tools/call answers the soft 429 envelope. */
function fakeMcp(calls: string[]): Server {
  return createServer((req, res) => {
    void readBody(req).then((body) => {
      const rpc = JSON.parse(body) as { id: number; method: string; params?: { name?: string } }
      res.writeHead(200, { "content-type": "application/json" })
      if (rpc.method === "tools/list") {
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { tools: [{ name: "bnf_search_catalogue", inputSchema: { type: "object" } }] },
          }),
        )
        return
      }
      calls.push(rpc.params?.name ?? "<unnamed>")
      const envelope = { success: false, error: "HTTP 429", status_code: 429, context: "bnf_search_catalogue" }
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { content: [{ type: "text", text: JSON.stringify(envelope) }] },
        }),
      )
    })
  })
}

test("the real Claude runner dispatches every bnf__ call through the rate limiter", async () => {
  __resetBnfRateLimiterForTests(RATES)
  const anthropicRequests: unknown[] = []
  const mcpCalls: string[] = []
  const anthropic = fakeAnthropic(anthropicRequests)
  const mcp = fakeMcp(mcpCalls)
  const anthropicUrl = await listen(anthropic)
  const mcpUrl = await listen(mcp)
  try {
    const registry = withBnfRateLimit(
      createToolRegistry({ mcpServers: [{ name: BNF_MCP_SERVER_NAME, url: `${mcpUrl}/mcp` }] }),
    )
    const controller = new AbortController()
    const results = new Map<string, { isError: boolean; content: string }>()
    for await (const event of runClaudeSdk({
      apiKey: "test-key",
      baseURL: anthropicUrl,
      model: "claude-test",
      messages: [{ role: "user", content: "cherche" }],
      system: "test",
      tools: registry,
      toolContext: { signal: controller.signal, request: new Request("http://localhost/test") },
      signal: controller.signal,
    })) {
      if (event.type === "error") assert.fail(`runner error: ${event.message}`)
      if (event.type === "tool-result") {
        const content = typeof event.content === "string" ? event.content : JSON.stringify(event.content)
        results.set(event.toolUseId, { isError: event.isError, content })
      }
    }

    assert.deepEqual(mcpCalls, ["bnf_search_catalogue"], "exactly one call reached the MCP")
    assert.equal(anthropicRequests.length, 2, "the loop went back to the model with the results")

    const first = results.get("toolu_1")
    assert.ok(first, "the first call has a result")
    assert.match(first.content, /"status_code":\s*429/)

    const shed = results.get("toolu_2")
    assert.ok(shed, "the second call has a result")
    assert.equal(shed.isError, true)
    const shedPayload: unknown = JSON.parse(shed.content)
    assert.deepEqual(
      typeof shedPayload === "object" && shedPayload !== null && "rate_limited" in shedPayload
        ? { rate_limited: shedPayload.rate_limited, api: "api" in shedPayload ? shedPayload.api : null }
        : null,
      { rate_limited: true, api: "catalogue" },
      "shed by the freeze the 429 caused",
    )

    const refused = results.get("toolu_3")
    assert.ok(refused, "the unknown tool has a result")
    assert.equal(refused.isError, true)
    assert.match(refused.content, /"refused":"bnf_call_refused"/)
    assert.match(refused.content, /bnf_some_future_tool/)
  } finally {
    await close(anthropic)
    await close(mcp)
  }
})
