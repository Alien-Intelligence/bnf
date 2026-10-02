// lib/cluster/datacluster-mcp-client.test.ts
// The data-cluster MCP client with `fetch` stubbed: a failed handshake is not
// cached, and envelopes and payloads are parsed, never cast.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { z } from "zod"
import {
  DataclusterMcpClient,
  DataclusterMcpNotFoundError,
  DataclusterMcpProtocolError,
  DataclusterMcpRequestError,
} from "./datacluster-mcp-client"

/** The part of a JSON-RPC request the stub routes on. */
const rpcRequestSchema = z.object({ method: z.string() })

// The client needs a URL and a token to exist; the stub answers every call.
process.env.DATACLUSTER_MCP_URL ??= "https://cluster.invalid/mcp"
process.env.CLUSTER_BEARER_TOKEN ??= "test-token"

const realFetch = globalThis.fetch
let handler: (body: { method: string }) => Response
let initializeCalls = 0

before(() => {
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = rpcRequestSchema.parse(JSON.parse(String(init?.body)))
    if (body.method === "initialize") initializeCalls++
    return handler(body)
  }
})
after(() => {
  globalThis.fetch = realFetch
})

function toolResult(payload: unknown): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: "1", result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}
function session(): Response {
  return new Response("{}", { status: 200, headers: { "mcp-session-id": "s1" } })
}

test("a failed handshake is dropped, so the retry opens a new session instead of re-awaiting the failure", async () => {
  initializeCalls = 0
  let failFirst = true
  handler = (body) => {
    if (body.method === "initialize") {
      if (failFirst) {
        failFirst = false
        return new Response("upstream down", { status: 503 })
      }
      return session()
    }
    return toolResult({ success: true, data: { datasets: [{ id: 3, name: "n", slug: "bnf-x", entry_count: 1 }] } })
  }
  const datasets = await new DataclusterMcpClient({ signal: new AbortController().signal }).listDatasets(10, 0)
  assert.deepEqual(datasets.map((d) => d.id), [3])
  assert.equal(initializeCalls, 2)
})

test("a payload that breaks its schema is a protocol error, not a cast", async () => {
  handler = (body) =>
    body.method === "initialize" ? session() : toolResult({ success: true, data: { datasets: [{ id: "three" }] } })
  await assert.rejects(new DataclusterMcpClient({ signal: new AbortController().signal }).listDatasets(10, 0), DataclusterMcpProtocolError)
})

test("a logical failure without an error message says so instead of 'unknown error'", async () => {
  handler = (body) => (body.method === "initialize" ? session() : toolResult({ success: false }))
  await assert.rejects(new DataclusterMcpClient({ signal: new AbortController().signal }).listDatasets(10, 0), /failed without an error message/)
})

test("a response with no content-type is a protocol error", async () => {
  // A byte body gets no implicit content-type (a string body would get text/plain).
  handler = (body) =>
    body.method === "initialize"
      ? session()
      : new Response(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0" })), { status: 200 })
  await assert.rejects(
    new DataclusterMcpClient({ signal: new AbortController().signal }).listDatasets(10, 0),
    (err: unknown) => err instanceof DataclusterMcpProtocolError && /no content-type/.test(err.message),
  )
})

test("an HTTP 400 that is not a stale session is a terminal request error (no retry)", async () => {
  let toolCalls = 0
  handler = (body) => {
    if (body.method === "initialize") return session()
    toolCalls++
    return new Response("invalid dataset_ids", { status: 400 })
  }
  await assert.rejects(
    new DataclusterMcpClient({ signal: new AbortController().signal }).listDatasets(10, 0),
    (err: unknown) => err instanceof DataclusterMcpRequestError && /invalid dataset_ids/.test(err.message),
  )
  assert.equal(toolCalls, 1)
})

test("JSON-RPC invalid params is a terminal request error", async () => {
  handler = (body) =>
    body.method === "initialize"
      ? session()
      : new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32602, message: "bad limit" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
  await assert.rejects(
    new DataclusterMcpClient({ signal: new AbortController().signal }).listDatasets(10, 0),
    DataclusterMcpRequestError,
  )
})

test("a 5xx keeps its body in the error message", async () => {
  handler = (body) => (body.method === "initialize" ? session() : new Response("qdrant unavailable", { status: 503 }))
  await assert.rejects(
    new DataclusterMcpClient({ signal: new AbortController().signal }).listDatasets(10, 0),
    /HTTP 503 calling datacluster_list_datasets: qdrant unavailable/,
  )
})

test("a 404 for our session id re-initializes once, then succeeds", async () => {
  initializeCalls = 0
  let toolCalls = 0
  handler = (body) => {
    if (body.method === "initialize") return session()
    toolCalls++
    return toolCalls === 1
      ? new Response("Session not found", { status: 404 })
      : toolResult({ success: true, data: { datasets: [] } })
  }
  assert.deepEqual(await new DataclusterMcpClient({ signal: new AbortController().signal }).listDatasets(10, 0), [])
  assert.equal(initializeCalls, 2, "the session was renewed")
})

test("a second 404 after renewing the session is terminal", async () => {
  let toolCalls = 0
  handler = (body) => {
    if (body.method === "initialize") return session()
    toolCalls++
    return new Response("no such endpoint", { status: 404 })
  }
  await assert.rejects(
    new DataclusterMcpClient({ signal: new AbortController().signal }).listDatasets(10, 0),
    DataclusterMcpNotFoundError,
  )
  assert.equal(toolCalls, 2)
})

test("a 400 to initialize and JSON-RPC parse / invalid-request errors are terminal", async () => {
  let inits = 0
  handler = (body) => {
    if (body.method === "initialize") {
      inits++
      return new Response("bad protocolVersion", { status: 400 })
    }
    return toolResult({ success: true, data: { datasets: [] } })
  }
  await assert.rejects(new DataclusterMcpClient({ signal: new AbortController().signal }).listDatasets(10, 0), DataclusterMcpRequestError)
  assert.equal(inits, 1, "not retried")
  for (const code of [-32700, -32600]) {
    handler = (body) =>
      body.method === "initialize"
        ? session()
        : new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code, message: "x" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
    await assert.rejects(new DataclusterMcpClient({ signal: new AbortController().signal }).listDatasets(10, 0), DataclusterMcpRequestError)
  }
})

test("a 400 that merely mentions a session is not taken for a stale one", async () => {
  handler = (body) =>
    body.method === "initialize" ? session() : new Response("dataset_ids must not reference session data", { status: 400 })
  await assert.rejects(new DataclusterMcpClient({ signal: new AbortController().signal }).listDatasets(10, 0), DataclusterMcpRequestError)
})
