// lib/cluster/datacluster-mcp-client.test.ts
// The data-cluster MCP client with `fetch` stubbed: a failed handshake is not
// cached, and envelopes and payloads are parsed, never cast.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { z } from "zod"
import { DataclusterMcpClient, DataclusterMcpProtocolError } from "./datacluster-mcp-client"

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
  const datasets = await new DataclusterMcpClient().listDatasets(10, 0)
  assert.deepEqual(datasets.map((d) => d.id), [3])
  assert.equal(initializeCalls, 2)
})

test("a payload that breaks its schema is a protocol error, not a cast", async () => {
  handler = (body) =>
    body.method === "initialize" ? session() : toolResult({ success: true, data: { datasets: [{ id: "three" }] } })
  await assert.rejects(new DataclusterMcpClient().listDatasets(10, 0), DataclusterMcpProtocolError)
})

test("a logical failure without an error message says so instead of 'unknown error'", async () => {
  handler = (body) => (body.method === "initialize" ? session() : toolResult({ success: false }))
  await assert.rejects(new DataclusterMcpClient().listDatasets(10, 0), /failed without an error message/)
})

test("a response with no content-type is a protocol error", async () => {
  // A byte body gets no implicit content-type (a string body would get text/plain).
  handler = (body) =>
    body.method === "initialize"
      ? session()
      : new Response(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0" })), { status: 200 })
  await assert.rejects(
    new DataclusterMcpClient().listDatasets(10, 0),
    (err: unknown) => err instanceof DataclusterMcpProtocolError && /no content-type/.test(err.message),
  )
})
