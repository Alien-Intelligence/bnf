// lib/cluster/mode.test.ts
// clusterMode() — an unset or misspelt CLUSTER_MODE fails loudly as "not set"
// instead of silently running the fake runner (review of Track B,
// CLAUDE_ERROR_PATTERNS §10: no default for environment).
import { test } from "node:test"
import assert from "node:assert/strict"

import { CLUSTER_MODE, clusterMode } from "./mode"

function withMode(value: string | undefined, run: () => void): void {
  const saved = process.env.CLUSTER_MODE
  if (value === undefined) delete process.env.CLUSTER_MODE
  else process.env.CLUSTER_MODE = value
  try {
    run()
  } finally {
    if (saved === undefined) delete process.env.CLUSTER_MODE
    else process.env.CLUSTER_MODE = saved
  }
}

test("real and fake are read as is", () => {
  withMode("real", () => assert.equal(clusterMode(), CLUSTER_MODE.REAL))
  withMode("fake", () => assert.equal(clusterMode(), CLUSTER_MODE.FAKE))
})

test("unset or blank throws 'not set'", () => {
  withMode(undefined, () => assert.throws(() => clusterMode(), /not set/))
  withMode("  ", () => assert.throws(() => clusterMode(), /not set/))
})

test("an unknown value throws", () => {
  withMode("Real", () => assert.throws(() => clusterMode(), /must be/))
})
