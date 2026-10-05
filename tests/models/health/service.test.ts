// models/health/service.test.ts
// Real cluster mode without the data-cluster env cannot reach the cluster:
// the Alien lane must be red, never a quiet green.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { CLUSTER_MODE } from "@/lib/cluster/mode"
import { HealthService } from "@/models/health/service"

const saved: Record<string, string | undefined> = {}
const KEYS = ["CLUSTER_MODE", "DATACLUSTER_MCP_URL", "CLUSTER_BEARER_TOKEN", "BNF_MCP_URL", "BNF_MCP_TOKEN"]

before(() => {
  for (const k of KEYS) saved[k] = process.env[k]
  process.env.CLUSTER_MODE = CLUSTER_MODE.REAL
  // No data-cluster env; no BnF MCP env either, so nothing touches the network.
  for (const k of KEYS.slice(1)) delete process.env[k]
})
after(() => {
  for (const k of KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

test("real mode with the data-cluster env missing turns the Alien lane red", async () => {
  const snapshot = await HealthService.snapshot()
  assert.equal(snapshot.alien.status, "red")
  assert.equal(snapshot.alien.unreachable, true)
})
