import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { causedByOwnCeiling } from "./abort"

describe("causedByOwnCeiling", () => {
  it("recognises the signal's own reason", () => {
    const controller = new AbortController()
    const reason = new Error("ceiling")
    controller.abort(reason)
    assert.equal(causedByOwnCeiling(reason, controller.signal), true)
  })

  it("recognises an AbortError", () => {
    const abort = new DOMException("aborted", "AbortError")
    assert.equal(causedByOwnCeiling(abort, new AbortController().signal), true)
  })

  it("follows the cause chain", () => {
    const controller = new AbortController()
    const reason = new Error("ceiling")
    controller.abort(reason)
    assert.equal(causedByOwnCeiling(new Error("fetch failed", { cause: reason }), controller.signal), true)
  })

  it("does not claim a remote failure that lands after the ceiling", () => {
    const controller = new AbortController()
    controller.abort(new Error("ceiling"))
    assert.equal(causedByOwnCeiling(new Error("404 not found"), controller.signal), false)
  })

  it("stops following an unbounded cause chain", () => {
    const controller = new AbortController()
    const reason = new Error("ceiling")
    controller.abort(reason)
    let error: Error = reason
    for (let i = 0; i < 10; i++) error = new Error(`wrap ${i}`, { cause: error })
    assert.equal(causedByOwnCeiling(error, controller.signal), false)
  })

  it("is false for non-errors", () => {
    assert.equal(causedByOwnCeiling(undefined, new AbortController().signal), false)
    assert.equal(causedByOwnCeiling("boom", new AbortController().signal), false)
  })
})
