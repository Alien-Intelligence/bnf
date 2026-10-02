// tests/models/documents/ocr-sync.test.ts
// The pure planning behind the OCR-quality sync drainer (feedback 2026-09-29
// #7, Track B): when a sweep cycle stops, how a contract-breaking batch is
// split to isolate the ARK at fault, and the coverage check that turns an
// incomplete worker answer into a typed contract error. The I/O shell is
// exercised by ocr-record.test.ts against the dev database and manually.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import { OCR_SYNC_BATCH_SIZE, OCR_SYNC_MAX_BATCHES_PER_CYCLE } from "@/lib/constants"
import { OcrSyncContractError } from "@/lib/cluster/ocr-quality"
import { remainingMs, shouldContinueCycle, splitBatch } from "@/lib/documents/ocr-sync"
import { assertSyncCoverage } from "@/models/documents/service"

const ark = (i: number) => `ark:/12148/bpt6k${String(i).padStart(6, "0")}`

test("shouldContinueCycle: a full batch continues", () => {
  assert.equal(shouldContinueCycle({ batchesDone: 1, lastBatchSize: OCR_SYNC_BATCH_SIZE }), true)
})

test("shouldContinueCycle: a partial batch means the pending set is exhausted", () => {
  assert.equal(shouldContinueCycle({ batchesDone: 1, lastBatchSize: 3 }), false)
  assert.equal(shouldContinueCycle({ batchesDone: 1, lastBatchSize: 0 }), false)
})

test("shouldContinueCycle: stops after OCR_SYNC_MAX_BATCHES_PER_CYCLE full batches", () => {
  assert.equal(
    shouldContinueCycle({ batchesDone: OCR_SYNC_MAX_BATCHES_PER_CYCLE - 1, lastBatchSize: OCR_SYNC_BATCH_SIZE }),
    true,
  )
  assert.equal(
    shouldContinueCycle({ batchesDone: OCR_SYNC_MAX_BATCHES_PER_CYCLE, lastBatchSize: OCR_SYNC_BATCH_SIZE }),
    false,
  )
})

test("splitBatch: two halves that cover the batch exactly", () => {
  const arks = [ark(1), ark(2), ark(3), ark(4), ark(5)]
  const [a, b] = splitBatch(arks)
  assert.deepEqual(a, [ark(1), ark(2), ark(3)])
  assert.deepEqual(b, [ark(4), ark(5)])
})

test("splitBatch: repeated halving isolates one ARK in log2(n) steps", () => {
  let batch = Array.from({ length: OCR_SYNC_BATCH_SIZE }, (_, i) => ark(i))
  let steps = 0
  while (batch.length > 1) {
    batch = splitBatch(batch)[1]
    steps += 1
  }
  assert.ok(steps <= Math.ceil(Math.log2(OCR_SYNC_BATCH_SIZE)))
})

test("splitBatch: a single ARK cannot be split (it is the culprit)", () => {
  assert.throws(() => splitBatch([ark(1)]))
})

test("remainingMs: never negative", () => {
  assert.equal(remainingMs(1_000, 400), 600)
  assert.equal(remainingMs(1_000, 5_000), 0)
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

test("assertSyncCoverage: a missing ARK is a contract error (it would stay pending forever)", () => {
  assert.throws(
    () => assertSyncCoverage([ark(1), ark(2)], { documents: [], building: [ark(1)], unavailable: [] }),
    (err: unknown) => err instanceof OcrSyncContractError && /bpt6k000002/.test(err.message),
  )
})

test("assertSyncCoverage: an ARK nobody asked for is a contract error", () => {
  assert.throws(
    () => assertSyncCoverage([ark(1)], { documents: [], building: [ark(1), ark(9)], unavailable: [] }),
    (err: unknown) => err instanceof OcrSyncContractError && /bpt6k000009/.test(err.message),
  )
})
