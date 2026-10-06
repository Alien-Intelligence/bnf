// tests/lib/documents/ocr-sync-signal.test.ts
// The commit → drainer signal must cross module instances: Next.js loads
// instrumentation.ts (the subscriber) and the route handlers (the emitter) in
// separate bundles, so the channel lives on globalThis under a registered
// symbol, where any copy of the module finds the same emitter.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"

import { onOcrSyncRequested, requestOcrSync } from "@/lib/documents/ocr-sync-signal"

const CHANNEL_KEY = Symbol.for("bnf.documents.ocr-sync-signal")

test("the channel is process-wide: what another bundle's copy would find on globalThis", () => {
  let heardHere = 0
  const unsubscribe = onOcrSyncRequested(() => {
    heardHere += 1
  })
  const shared: unknown = Reflect.get(globalThis, CHANNEL_KEY)
  assert.ok(shared instanceof EventEmitter, "the emitter is on globalThis")

  // Another bundle's copy subscribes through the global it finds…
  let heardThere = 0
  const otherListener = (): void => {
    heardThere += 1
  }
  shared.on("ocr-sync-requested", otherListener)
  // …and hears this copy's signal.
  requestOcrSync()
  shared.off("ocr-sync-requested", otherListener)
  unsubscribe()
  requestOcrSync()
  assert.deepEqual([heardHere, heardThere], [1, 1])
})
