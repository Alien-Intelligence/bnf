// lib/mcp/rate-limited-registry-runner.test.ts
// Decision 17 of the Track E plan, proved on the SDK's REAL dispatch paths:
// BOTH runners — `runOpenRouterSdk` (production: AGENT_PROVIDER=openrouter) and
// `runClaudeSdk` — over the registry the chat route really builds,
// `buildTurnScopedRegistry`, which discovers mcp-bnf through
// `resolveMcpServers` (initialize + tools/list). Only the TRANSPORTS are fakes:
// a local OpenAI-compatible streaming endpoint (OpenRouter), a local Anthropic
// streaming endpoint, and a local mcp-bnf. The model asks for BnF calls; the
// limiter must sit between the runner and the MCP transport so that
//   1. the first catalogue call reaches the MCP, which answers mcp-bnf's
//      soft 429 envelope → the catalogue limiter is paused;
//   2. the second catalogue call is shed by that pause and never sent;
//   3. (Claude) a `bnf__` tool the limiter does not know is refused, never sent.
// No real network: every server listens on 127.0.0.1, Langfuse is disabled.
import "server-only"

for (const key of Object.keys(process.env)) {
  if (key.startsWith("LANGFUSE_")) delete process.env[key]
}

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { runClaudeSdk } from "@alien/chat-sdk/claude"
import { runOpenRouterSdk } from "@alien/chat-sdk/openrouter"
import { prisma } from "@/lib/db"
import { buildTurnScopedRegistry, type TurnScopedCtx } from "@/lib/agent/tools/registry-factory"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import { USER_ROLE } from "@/models/users/schema"
import { __resetBnfRateLimiterForTests } from "./rate-limit"
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
      if (rpc.method === "initialize") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26", capabilities: {} } }))
        return
      }
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

/** OpenAI-compatible streaming chunks (what OpenRouter speaks). */
function openAiChunk(delta: Record<string, unknown>, finish: string | null) {
  return `data: ${JSON.stringify({
    id: "gen-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

/**
 * Step 1: one catalogue call. Step 2 (after its 429 came back): another
 * catalogue call. Step 3: a closing text. Sequential on purpose — the AI SDK
 * runs the tool calls of ONE step in parallel, so both would be granted before
 * the first 429 is seen; the pause applies to calls made after it.
 */
function fakeOpenRouter(requests: unknown[]): Server {
  return createServer((req, res) => {
    void readBody(req).then((body) => {
      requests.push(JSON.parse(body))
      res.writeHead(200, { "content-type": "text/event-stream" })
      const call = (id: string, query: string) => ({
        index: 0,
        id,
        type: "function",
        function: { name: bnfPrefixedToolName("bnf_search_catalogue"), arguments: JSON.stringify({ query }) },
      })
      if (requests.length <= 2) {
        const id = requests.length === 1 ? "call_1" : "call_2"
        res.end(
          openAiChunk({ role: "assistant", tool_calls: [call(id, id)] }, null) +
            openAiChunk({}, "tool_calls") +
            "data: [DONE]\n\n",
        )
        return
      }
      res.end(openAiChunk({ role: "assistant", content: "fini" }, null) + openAiChunk({}, "stop") + "data: [DONE]\n\n")
    })
  })
}

/** A turn context for the registry: only the BnF tools are dispatched, so no DB call happens. */
function turnCtx(signal: AbortSignal): TurnScopedCtx {
  return {
    signal,
    request: new Request("http://localhost/test"),
    db: prisma,
    user: {
      id: "runner-test",
      email: "runner@test.local",
      name: "runner",
      emailVerified: true,
      image: null,
      role: USER_ROLE.MEMBER,
      alienUserId: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      groupIds: [],
    },
    appSessionId: "s-runner",
    projectId: "p-runner",
    corpusProjectId: "p-runner",
    corpusReachable: true,
    scope: SESSION_SCOPE.CORPUS,
  }
}

const mcpCalls: string[] = []
let mcp: Server
let mcpUrl: string

before(async () => {
  mcp = fakeMcp(mcpCalls)
  mcpUrl = await listen(mcp)
  // resolveMcpServers (inside buildTurnScopedRegistry) reads these, lazily.
  process.env.BNF_MCP_URL = `${mcpUrl}/mcp`
  process.env.BNF_MCP_TOKEN = "test-token"
})

after(async () => {
  await close(mcp)
})

/** The tool results of one run, by call id. */
type Results = Map<string, { isError: boolean; content: string }>

function assertShedByFreeze(results: Results, firstId: string, secondId: string): void {
  const first = results.get(firstId)
  assert.ok(first, "the first call has a result")
  assert.match(first.content, /"status_code":\s*429/)
  const shed = results.get(secondId)
  assert.ok(shed, "the second call has a result")
  assert.match(shed.content, /"rate_limited":true/)
  assert.match(shed.content, /"api":"catalogue"/, "shed by the pause the 429 caused")
}

test("OpenRouter (the production runner) dispatches every bnf__ call through the limiter", async () => {
  __resetBnfRateLimiterForTests(RATES)
  mcpCalls.length = 0
  const requests: unknown[] = []
  const openrouter = fakeOpenRouter(requests)
  const baseURL = await listen(openrouter)
  try {
    const controller = new AbortController()
    const registry = await buildTurnScopedRegistry(SESSION_SCOPE.CORPUS, controller.signal)
    assert.ok(registry.mcpServers.some((s) => s.name === BNF_MCP_SERVER_NAME), "the fake mcp-bnf was discovered")
    const results: Results = new Map()
    for await (const event of runOpenRouterSdk({
      apiKey: "test-key",
      baseURL,
      model: "test/model",
      messages: [{ role: "user", content: "cherche" }],
      system: "test",
      tools: registry,
      toolContext: turnCtx(controller.signal),
      signal: controller.signal,
    })) {
      if (event.type === "error") assert.fail(`runner error: ${event.message}`)
      if (event.type === "tool-result") {
        const content = typeof event.content === "string" ? event.content : JSON.stringify(event.content)
        results.set(event.toolUseId, { isError: event.isError, content })
      }
    }
    assert.deepEqual(mcpCalls, ["bnf_search_catalogue"], "exactly one call reached the MCP")
    assert.equal(requests.length, 3, "the loop went back to the model after each step")
    assertShedByFreeze(results, "call_1", "call_2")
  } finally {
    await close(openrouter)
  }
})

test("the Claude runner dispatches every bnf__ call through the limiter, and refuses an unknown one", async () => {
  __resetBnfRateLimiterForTests(RATES)
  mcpCalls.length = 0
  const anthropicRequests: unknown[] = []
  const anthropic = fakeAnthropic(anthropicRequests)
  const anthropicUrl = await listen(anthropic)
  try {
    const controller = new AbortController()
    const registry = await buildTurnScopedRegistry(SESSION_SCOPE.CORPUS, controller.signal)
    const results: Results = new Map()
    for await (const event of runClaudeSdk({
      apiKey: "test-key",
      baseURL: anthropicUrl,
      model: "claude-test",
      messages: [{ role: "user", content: "cherche" }],
      system: "test",
      tools: registry,
      toolContext: turnCtx(controller.signal),
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
    assertShedByFreeze(results, "toolu_1", "toolu_2")
    const refused = results.get("toolu_3")
    assert.ok(refused, "the unknown tool has a result")
    assert.equal(refused.isError, true)
    assert.match(refused.content, /"refused":"bnf_call_refused"/)
  } finally {
    await close(anthropic)
  }
})
