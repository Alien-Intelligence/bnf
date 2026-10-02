// tests/models/notes/detail.test.ts
// The pure halves of NoteService.detail (feedback 2026-09-29 #7, Track B):
// which (ark, folio) pairs a note's OCR read asks for, and how one shared read
// is split back per note. Built from the note's Citation rows, which hold only
// ARKs the corpus vouched for: that is what keeps the global per-ARK quality
// table from answering for another project's corpus.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import type { Citation, NoteWithCitations } from "@/models/notes/schema"
import { attachNoteOcr, citationRefs } from "@/models/notes/service"

const A = "ark:/12148/bpt6k000001"
const B = "ark:/12148/bpt6k000002"
const C = "ark:/12148/bpt6k000003"

test("citationRefs: deduped (ark, folio) pairs, first-seen order", () => {
  assert.deepEqual(
    citationRefs([
      { ark: A, folio: 2 },
      { ark: B, folio: 7 },
      { ark: A, folio: 1 },
      { ark: A, folio: 2 },
    ]),
    [
      { ark: A, folio: 2 },
      { ark: B, folio: 7 },
      { ark: A, folio: 1 },
    ],
  )
})

test("citationRefs: a citation row without a folio is skipped", () => {
  assert.deepEqual(citationRefs([{ ark: A, folio: null }, { ark: B, folio: 3 }]), [
    { ark: B, folio: 3 },
  ])
})

test("citationRefs: no citation → no ref", () => {
  assert.deepEqual(citationRefs([]), [])
})

function citation(ark: string, folio: number | null): Citation {
  return { id: `${ark}-${folio}`, noteId: "n1", ark, folio, label: "x" }
}

function note(citations: Citation[]): NoteWithCitations {
  return {
    id: "n1",
    projectId: "p1",
    appSessionId: null,
    title: "t",
    body_md: "",
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    pinned: false,
    citationCount: citations.length,
    citations,
  }
}

test("attachNoteOcr: only the note's own cited folios and documents", () => {
  const rows = {
    folios: [
      { ark: A, folio: 2, ocrSource: "alto", ocrQuality: 0.6, wordCount: 10 },
      { ark: A, folio: 3, ocrSource: "alto", ocrQuality: 0.9, wordCount: 10 },
      { ark: B, folio: 7, ocrSource: "alto", ocrQuality: 0.5, wordCount: 10 },
    ],
    documents: [
      { ark: A, status: "available" },
      { ark: B, status: "available" },
      { ark: C, status: "building" },
    ],
  }
  const detail = attachNoteOcr(note([citation(A, 2), citation(C, 1)]), rows)
  assert.deepEqual(
    detail.folioOcr.map((f) => [f.ark, f.folio]),
    [[A, 2]],
  )
  assert.deepEqual(
    detail.documentOcr.map((d) => d.ark).sort(),
    [A, C],
  )
})
