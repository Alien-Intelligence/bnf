// tests/models/documents/ocr-sync.test.ts
// The pure planning behind the OCR-quality sync (feedback 2026-09-29 #7,
// Track B, Phase 4): how the drainer batches forced ARKs, when a sweep cycle
// stops, and the check that the worker answered exactly what was asked.
// Pure, no Prisma and no worker — the I/O shell is exercised manually and by
// ocr-record.test.ts against the dev database.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  OCR_SYNC_BATCH_SIZE,
  OCR_SYNC_BUILDING_RECHECK_MS,
  OCR_SYNC_MAX_BATCHES_PER_CYCLE,
  OCR_SYNC_UNAVAILABLE_RECHECK_MS,
} from "@/lib/constants"
import {
  chunk,
  planForcedBatches,
  recheckCutoffs,
  shouldContinueCycle,
} from "@/lib/documents/ocr-sync"
import { assertSyncCoverage } from "@/models/documents/service"

const ark = (i: number) => `ark:/12148/bpt6k${String(i).padStart(6, "0")}`

test("chunk: splits into OCR_SYNC_BATCH_SIZE batches, last one partial", () => {
  const arks = Array.from({ length: OCR_SYNC_BATCH_SIZE * 2 + 5 }, (_, i) => ark(i))
  const batches = chunk(arks, OCR_SYNC_BATCH_SIZE)
  assert.deepEqual(
    batches.map((b) => b.length),
    [OCR_SYNC_BATCH_SIZE, OCR_SYNC_BATCH_SIZE, 5],
  )
  assert.deepEqual(batches.flat(), arks)
})

test("chunk: empty input → no batch", () => {
  assert.deepEqual(chunk([], OCR_SYNC_BATCH_SIZE), [])
})

test("chunk: a non-positive size is a programming error", () => {
  assert.throws(() => chunk([ark(1)], 0))
})

test("planForcedBatches: forced kick ARKs are batched as given, deduped — no pending filter", () => {
  // A re-ingest kick re-pulls ARKs that are already `available`: the plan is
  // built from the kick's ARKs alone, never from the pending query.
  assert.deepEqual(planForcedBatches([ark(1), ark(2), ark(1)]), [[ark(1), ark(2)]])
})

test("planForcedBatches: more than one batch", () => {
  const arks = Array.from({ length: OCR_SYNC_BATCH_SIZE + 1 }, (_, i) => ark(i))
  assert.deepEqual(
    planForcedBatches(arks).map((b) => b.length),
    [OCR_SYNC_BATCH_SIZE, 1],
  )
})

test("shouldContinueCycle: a full batch continues", () => {
  assert.equal(shouldContinueCycle({ batchesDone: 1, lastBatchSize: OCR_SYNC_BATCH_SIZE }), true)
})

test("shouldContinueCycle: a partial batch means the pending set is exhausted", () => {
  assert.equal(shouldContinueCycle({ batchesDone: 1, lastBatchSize: 3 }), false)
  assert.equal(shouldContinueCycle({ batchesDone: 1, lastBatchSize: 0 }), false)
})

test("shouldContinueCycle: stops after OCR_SYNC_MAX_BATCHES_PER_CYCLE full batches", () => {
  assert.equal(
    shouldContinueCycle({
      batchesDone: OCR_SYNC_MAX_BATCHES_PER_CYCLE - 1,
      lastBatchSize: OCR_SYNC_BATCH_SIZE,
    }),
    true,
  )
  assert.equal(
    shouldContinueCycle({
      batchesDone: OCR_SYNC_MAX_BATCHES_PER_CYCLE,
      lastBatchSize: OCR_SYNC_BATCH_SIZE,
    }),
    false,
  )
})

test("recheckCutoffs: building and unavailable windows", () => {
  const now = new Date("2026-10-02T12:00:00Z")
  assert.deepEqual(recheckCutoffs(now), {
    buildingCutoff: new Date(now.getTime() - OCR_SYNC_BUILDING_RECHECK_MS),
    unavailableCutoff: new Date(now.getTime() - OCR_SYNC_UNAVAILABLE_RECHECK_MS),
  })
})

test("assertSyncCoverage: exactly the asked ARKs → ok", () => {
  assert.doesNotThrow(() =>
    assertSyncCoverage([ark(1), ark(2), ark(3)], {
      documents: [
        { v: 1, ark: ark(1), ocrRate: null, lane: "vision", folios: [], builtAt: "2026-10-01T13:49:42.385Z" },
      ],
      building: [ark(2)],
      unavailable: [{ ark: ark(3), reason: "no_pages_artifact" }],
    }),
  )
})

test("assertSyncCoverage: a missing ARK throws (it would stay pending forever)", () => {
  assert.throws(
    () => assertSyncCoverage([ark(1), ark(2)], { documents: [], building: [ark(1)], unavailable: [] }),
    /bpt6k000002/,
  )
})

test("assertSyncCoverage: an ARK nobody asked for throws", () => {
  assert.throws(
    () => assertSyncCoverage([ark(1)], { documents: [], building: [ark(1), ark(9)], unavailable: [] }),
    /bpt6k000009/,
  )
})
