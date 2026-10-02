// lib/mcp/retry.test.ts
// withRetry and the caller's signal: once it aborts, nothing more is tried.
import { test } from "node:test"
import assert from "node:assert/strict"
import { withRetry } from "./retry"

const fast = { attempts: 5, baseMs: 1, capMs: 1, isTerminal: () => false }

test("a transient failure is retried until it succeeds", async () => {
  let calls = 0
  const out = await withRetry(async () => {
    calls++
    if (calls < 3) throw new Error("blip")
    return "ok"
  }, fast)
  assert.equal(out, "ok")
  assert.equal(calls, 3)
})

test("after the caller aborts, the failure is re-thrown without a retry", async () => {
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(
    withRetry(async () => {
      calls++
      controller.abort()
      throw new Error("aborted fetch")
    }, { ...fast, signal: controller.signal }),
    /aborted fetch/,
  )
  assert.equal(calls, 1)
})

test("an abort during the backoff wait rejects at once with the signal's reason", async () => {
  const controller = new AbortController()
  let calls = 0
  const started = Date.now()
  const pending = withRetry(async () => {
    calls++
    throw new Error("blip")
  }, { attempts: 5, baseMs: 10_000, capMs: 10_000, isTerminal: () => false, signal: controller.signal })
  setTimeout(() => controller.abort(new Error("turn cancelled")), 20)
  await assert.rejects(pending, /turn cancelled/)
  assert.equal(calls, 1)
  assert.ok(Date.now() - started < 5_000, "did not sit out the 10 s backoff")
})

test("an already-aborted signal starts no attempt", async () => {
  const controller = new AbortController()
  controller.abort(new Error("gone"))
  let calls = 0
  await assert.rejects(
    withRetry(async () => {
      calls++
      return "never"
    }, { ...fast, signal: controller.signal }),
    /gone/,
  )
  assert.equal(calls, 0)
})
