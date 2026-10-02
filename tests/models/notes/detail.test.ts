// tests/models/notes/detail.test.ts
// citationRefs — the (ark, folio) pairs whose OCR quality a note detail loads
// (feedback 2026-09-29 #7, Track B, Phase 6). Built from the note's Citation
// rows, which hold only ARKs the corpus vouched for: that is what keeps the
// global per-ARK quality table from answering for another project's corpus.
import { test } from "node:test"
import assert from "node:assert/strict"

import { citationRefs } from "@/models/notes/schema"

const A = "ark:/12148/bpt6k000001"
const B = "ark:/12148/bpt6k000002"

test("groups by ARK with deduped folios, first-seen order", () => {
  assert.deepEqual(
    citationRefs([
      { ark: A, folio: 2 },
      { ark: B, folio: 7 },
      { ark: A, folio: 1 },
      { ark: A, folio: 2 },
    ]),
    [
      { ark: A, folios: [2, 1] },
      { ark: B, folios: [7] },
    ],
  )
})

test("a citation row without a folio is skipped", () => {
  assert.deepEqual(citationRefs([{ ark: A, folio: null }, { ark: B, folio: 3 }]), [
    { ark: B, folios: [3] },
  ])
})

test("no citation → no ref", () => {
  assert.deepEqual(citationRefs([]), [])
})
