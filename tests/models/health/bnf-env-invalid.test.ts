// tests/models/health/bnf-env-invalid.test.ts
// A BnF MCP env that is set but invalid (a malformed URL) is a deployment that
// cannot reach the BnF MCP: the Alien lane is red and flagged unreachable —
// not treated as "not configured" and left green. (Own file: the probe result
// is cached per process.)
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { CLUSTER_MODE } from "@/lib/cluster/mode"
import { HealthService } from "@/models/health/service"

const KEYS = ["CLUSTER_MODE", "BNF_MCP_URL", "BNF_MCP_TOKEN"] as const
const saved: Record<string, string | undefined> = {}

before(() => {
  for (const k of KEYS) saved[k] = process.env[k]
  // Fake cluster mode: the data-cluster lane is healthy by definition, so only
  // the BnF env can turn the lane red. The malformed URL never reaches the network.
  process.env.CLUSTER_MODE = CLUSTER_MODE.FAKE
  process.env.BNF_MCP_URL = "not a url"
  process.env.BNF_MCP_TOKEN = "token"
})
after(() => {
  for (const k of KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

test("a malformed BnF MCP env turns the Alien lane red, unreachable", async () => {
  const snapshot = await HealthService.snapshot()
  assert.equal(snapshot.alien.status, "red")
  assert.equal(snapshot.alien.unreachable, true)
})
