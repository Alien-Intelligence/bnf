// tests/models/ingest/paid-ocr-estimate.test.ts
// estimatePaidOcrCostUsd — SDS-945 A3. A sans_texte document whose page count is
// unknown (null: fascicules, unresolved stubs) is held at the per-document
// maximum rather than a guessed small number, so the confirmed estimate is an
// upper bound on what the worker can transcribe.
import { test } from "node:test"
import assert from "node:assert/strict"

import { PAID_OCR_MAX_PAGES_PER_DOC, PAID_OCR_USD_PER_1K_PAGES } from "@/lib/constants"
import { estimatePaidOcrCostUsd } from "@/models/ingest/schema"

const usdFor = (pages: number) => (pages / 1000) * PAID_OCR_USD_PER_1K_PAGES

test("null page count is held at the per-document maximum", () => {
  const estimate = estimatePaidOcrCostUsd([null])
  assert.equal(PAID_OCR_MAX_PAGES_PER_DOC, 300)
  assert.deepEqual(estimate, { docCount: 1, pages: 300, usd: usdFor(300) })
})

test("undefined page count is held at the per-document maximum", () => {
  assert.equal(estimatePaidOcrCostUsd([undefined]).pages, PAID_OCR_MAX_PAGES_PER_DOC)
})

test("zero page count is held at the per-document maximum", () => {
  assert.equal(estimatePaidOcrCostUsd([0]).pages, PAID_OCR_MAX_PAGES_PER_DOC)
})

test("a page count above the cap is capped", () => {
  assert.equal(estimatePaidOcrCostUsd([3197]).pages, PAID_OCR_MAX_PAGES_PER_DOC)
})

test("a normal page count is priced as-is", () => {
  const estimate = estimatePaidOcrCostUsd([120])
  assert.deepEqual(estimate, { docCount: 1, pages: 120, usd: usdFor(120) })
})

test("a mixed set sums each document's held, capped or actual pages", () => {
  const estimate = estimatePaidOcrCostUsd([null, 4, 3197, 0, 120])
  const expectedPages = 300 + 4 + 300 + 300 + 120
  assert.deepEqual(estimate, {
    docCount: 5,
    pages: expectedPages,
    usd: usdFor(expectedPages),
  })
})

test("an empty set costs nothing", () => {
  assert.deepEqual(estimatePaidOcrCostUsd([]), { docCount: 0, pages: 0, usd: 0 })
})
