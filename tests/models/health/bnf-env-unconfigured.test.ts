// tests/models/health/bnf-env-unconfigured.test.ts
// No BnF MCP env at all is a deployment without the BnF MCP (local dev): it is
// not probed and does not flag the Alien lane unreachable. (Own file: the
// probe result is cached per process.)
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { CLUSTER_MODE } from "@/lib/cluster/mode"
import { HealthService } from "@/models/health/service"

const KEYS = ["CLUSTER_MODE", "BNF_MCP_URL", "BNF_MCP_TOKEN"] as const
const saved: Record<string, string | undefined> = {}

before(() => {
  for (const k of KEYS) saved[k] = process.env[k]
  process.env.CLUSTER_MODE = CLUSTER_MODE.FAKE
  delete process.env.BNF_MCP_URL
  delete process.env.BNF_MCP_TOKEN
})
after(() => {
  for (const k of KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

test("no BnF MCP env at all is unconfigured: not probed, not unreachable", async () => {
  const snapshot = await HealthService.snapshot()
  assert.notEqual(snapshot.alien.unreachable, true)
})
