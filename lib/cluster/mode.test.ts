// lib/cluster/mode.test.ts
import "server-only"

import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { CLUSTER_MODE, clusterMode } from "./mode"

const original = process.env.CLUSTER_MODE
afterEach(() => {
  if (original === undefined) delete process.env.CLUSTER_MODE
  else process.env.CLUSTER_MODE = original
})

test("fake and real are read as is", () => {
  process.env.CLUSTER_MODE = "real"
  assert.equal(clusterMode(), CLUSTER_MODE.REAL)
  process.env.CLUSTER_MODE = "fake"
  assert.equal(clusterMode(), CLUSTER_MODE.FAKE)
})

test("unset or an unknown value throws instead of silently serving the fake cluster", () => {
  delete process.env.CLUSTER_MODE
  assert.throws(() => clusterMode(), /CLUSTER_MODE must be set/)
  for (const bad of ["Real", "prod", ""]) {
    process.env.CLUSTER_MODE = bad
    assert.throws(() => clusterMode(), /CLUSTER_MODE must be set/)
  }
})
