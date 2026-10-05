// tests/scripts/e2e/harness.test.ts
// The e2e harness reads its environment at the point of use, never at import.
//
// It is tested because a script that only uses the verdict helpers (the auth
// e2e: check, section, printVerdict, against its own base URL) imports the
// same module as the paid agent e2es. A requirement evaluated at import made
// that script throw before its first line for want of a model it never calls.
// The other half matters as much: a turn without E2E_MODEL must still refuse
// to run, naming the variable, before it sends anything.
//
// The harness is imported dynamically, after the variables are removed: a
// static import is hoisted above any statement in this file and would load
// the module with whatever the shell happened to export.
import "server-only"

import { afterEach, beforeEach, test } from "node:test"
import assert from "node:assert/strict"

/** Loads (once, on the first call) the harness under the environment the test set. */
const loadHarness = () => import("@/scripts/e2e/harness")
const E2E_VARS = ["E2E_BASE_URL", "E2E_MODEL", "E2E_TURN_TIMEOUT_MS"] as const
/** Never contacted: every case below must fail before a request is made. */
const UNREACHED_BASE_URL = "http://127.0.0.1:9"

const savedEnv = new Map<string, string | undefined>()
const realFetch = globalThis.fetch
let fetchCalls: string[] = []

beforeEach(() => {
  for (const name of E2E_VARS) {
    savedEnv.set(name, process.env[name])
    delete process.env[name]
  }
  fetchCalls = []
  globalThis.fetch = (input: string | URL | Request) => {
    fetchCalls.push(input instanceof Request ? input.url : String(input))
    return Promise.reject(new Error("the harness must not reach the network in these tests"))
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test("importing the harness requires neither E2E_BASE_URL nor E2E_MODEL", async () => {
  const harness = await loadHarness()
  // The verdict helpers a model-free script uses work with neither set.
  harness.section("harness import test")
  harness.check("a check records without any e2e setting", true, "no env required")
  assert.equal(harness.verdicts.at(-1)?.ok, true)
})

test("a turn without E2E_MODEL fails naming the variable, before any request", async () => {
  process.env["E2E_BASE_URL"] = UNREACHED_BASE_URL
  const { runTurn } = await loadHarness()
  await assert.rejects(runTurn("session-id", "cookie=1", [{ role: "user", content: "bonjour" }]), {
    message: "E2E_MODEL is not set — e.g. E2E_MODEL=z-ai/glm-5.2",
  })
  assert.deepEqual(fetchCalls, [], "no turn was posted and no cancel was sent")
})

test("a script that calls the model fails on a missing E2E_MODEL before its setup", async () => {
  process.env["E2E_BASE_URL"] = UNREACHED_BASE_URL
  const { turnSettings } = await loadHarness()
  assert.throws(() => turnSettings(), { message: "E2E_MODEL is not set — e.g. E2E_MODEL=z-ai/glm-5.2" })
})

test("an empty E2E_MODEL is missing, not a model named ''", async () => {
  process.env["E2E_BASE_URL"] = UNREACHED_BASE_URL
  process.env["E2E_MODEL"] = "   "
  const { turnSettings } = await loadHarness()
  assert.throws(() => turnSettings(), { message: "E2E_MODEL is not set — e.g. E2E_MODEL=z-ai/glm-5.2" })
})

test("reaching the server without E2E_BASE_URL fails naming the variable, before any request", async () => {
  const { requireServer } = await loadHarness()
  await assert.rejects(requireServer(), {
    message: "E2E_BASE_URL is not set — e.g. E2E_BASE_URL=http://localhost:3939",
  })
  assert.deepEqual(fetchCalls, [])
})

test("with both set, the turn settings are what the caller stated", async () => {
  process.env["E2E_BASE_URL"] = `${UNREACHED_BASE_URL}/`
  process.env["E2E_MODEL"] = "z-ai/glm-5.2"
  const { turnSettings } = await loadHarness()
  assert.deepEqual(turnSettings(), { baseUrl: UNREACHED_BASE_URL, model: "z-ai/glm-5.2", turnTimeoutMs: 300_000 })
})
