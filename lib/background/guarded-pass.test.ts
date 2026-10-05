// lib/background/guarded-pass.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { guardedPass } from "./guarded-pass"

test("a call while the pass runs is skipped, and the guard clears when it settles", async () => {
  let runs = 0
  let release: () => void = () => undefined
  const pass = guardedPass("t", async () => {
    runs += 1
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  const first = pass()
  await pass() // skipped: resolves at once
  assert.equal(runs, 1)
  release()
  await first
  const second = pass()
  release()
  await second
  assert.equal(runs, 2, "the guard cleared after the first run settled")
})

test("a failing run clears its guard and rethrows", async () => {
  let runs = 0
  const pass = guardedPass("t", async () => {
    runs += 1
    throw new Error("boom")
  })
  await assert.rejects(pass(), /boom/)
  await assert.rejects(pass(), /boom/)
  assert.equal(runs, 2)
})

test("two passes are independent: one failing never skips the other", async () => {
  let reclassified = 0
  const lang = guardedPass("lang", async () => {
    throw new Error("lang down")
  })
  const reclassify = guardedPass("reclassify", async () => {
    reclassified += 1
  })
  const results = await Promise.allSettled([lang(), reclassify()])
  assert.equal(results[0].status, "rejected")
  assert.equal(results[1].status, "fulfilled")
  assert.equal(reclassified, 1)
})
