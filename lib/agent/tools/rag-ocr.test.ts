// lib/agent/tools/rag-ocr.test.ts
// The pure annotators that put OCR quality into the agent's corpus-text tool
// results (feedback 2026-09-29 #7, Track B, Phase 5). The model must SEE that a
// folio is poorly recognised — ocrLow is computed by code (isLowOcr), never
// left to the prompt — and must not mistake "not synced yet" for "fine".
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import { indexFolioOcr } from "@/lib/citations/ocr"
import type { RagKeywordHit, RagPassage } from "@/lib/cluster/rag"
import {
  OCR_SOURCE,
  OCR_STATUS_PENDING,
  OCR_SYNC_STATUS,
  toDocumentOcrView,
  toFolioOcrView,
  type DocumentFolioRow,
} from "@/models/documents/schema"
import { RAG_OCR_LOW_FOLIOS_MAX } from "@/lib/constants"

import { NOTE_LOW_OCR_NOTICE, RAG_OCR_LOW_NOTICE } from "./constants"
import {
  annotateKeywordHits,
  annotatePassages,
  annotateTextSlice,
  docOcrSummary,
  lowOcrForNoteResult,
} from "./rag-ocr"

const ARK = "ark:/12148/bpt6k4625753w"
const ARK_VISION = "ark:/12148/btv1b100524476"
const ARK_UNSYNCED = "ark:/12148/bpt6k000001"

function row(over: Partial<DocumentFolioRow>): DocumentFolioRow {
  return { ark: ARK, folio: 1, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.9, wordCount: 10, ...over }
}

const F1 = row({ folio: 1, ocrQuality: 0.932, wordCount: 5106 })
const F2 = row({ folio: 2, ocrQuality: 0.661, wordCount: 4016 })
const F3 = row({ folio: 3, ocrQuality: 0.8, wordCount: 3000 })
const F4 = row({ folio: 4, ocrQuality: null, wordCount: 12 })
const V1 = row({ ark: ARK_VISION, folio: 1, ocrSource: OCR_SOURCE.VISION, ocrQuality: null, wordCount: null })

const INDEX = indexFolioOcr([F1, F2, F3, F4, V1].map(toFolioOcrView))

function passage(over: Partial<RagPassage>): RagPassage {
  return { ark: ARK, folio: 1, snippet: "…", score: 0.5, charRange: [0, 10], entryId: 7, ...over }
}

// ---------------------------------------------------------------------------
// rag_query
// ---------------------------------------------------------------------------

test("annotatePassages: quality, source and low per (ark, folio)", () => {
  const { passages, ocrNotice } = annotatePassages(
    [passage({ folio: 1 }), passage({ folio: 2 })],
    INDEX,
  )
  assert.deepEqual(
    passages.map((p) => [p.folio, p.ocrQuality, p.ocrSource, p.ocrLow]),
    [
      [1, 0.932, "alto", false],
      [2, 0.661, "alto", true],
    ],
  )
  assert.equal(ocrNotice, RAG_OCR_LOW_NOTICE)
})

test("annotatePassages: the passage itself is kept as is", () => {
  const p = passage({ folio: 2, title: "L'Auto-vélo", year: 1910 })
  const [annotated] = annotatePassages([p], INDEX).passages
  assert.deepEqual({ ...annotated, ocrQuality: undefined, ocrSource: undefined, ocrLow: undefined }, {
    ...p,
    ocrQuality: undefined,
    ocrSource: undefined,
    ocrLow: undefined,
  })
})

test("annotatePassages: a null folio → ocrSource null, ocrLow false", () => {
  const { passages, ocrNotice } = annotatePassages([passage({ folio: null })], INDEX)
  assert.deepEqual(
    [passages[0].ocrSource, passages[0].ocrQuality, passages[0].ocrLow],
    [null, null, false],
  )
  assert.equal(ocrNotice, undefined)
})

test("annotatePassages: an unsynced folio → ocrSource null (distinct from a source with no score)", () => {
  const { passages } = annotatePassages(
    [passage({ ark: ARK_UNSYNCED, folio: 3 }), passage({ ark: ARK_VISION, folio: 1 })],
    INDEX,
  )
  assert.deepEqual(
    passages.map((p) => [p.ocrSource, p.ocrLow]),
    [
      [null, false],
      ["vision", false],
    ],
  )
})

test("annotatePassages: no low passage → no notice", () => {
  const { ocrNotice } = annotatePassages([passage({ folio: 1 }), passage({ folio: 3 })], INDEX)
  assert.equal(ocrNotice, undefined)
})

// ---------------------------------------------------------------------------
// rag_keyword_search
// ---------------------------------------------------------------------------

function hit(ark: string): RagKeywordHit {
  return { ark, entryId: 1, title: "t", date: null, score: 1, snippets: ["s"] }
}

test("annotateKeywordHits: ocrRate, sorted low folios and their count", () => {
  const docIndex = new Map([
    [
      ARK,
      toDocumentOcrView(ARK, {
        ark: ARK,
        status: OCR_SYNC_STATUS.AVAILABLE,
        ocrRate: 0.7821,
        reason: null,
        folios: [F2, F1, row({ folio: 9, ocrQuality: 0.1 })],
      }),
    ],
  ])
  const { hits, ocrNotice } = annotateKeywordHits([hit(ARK), hit(ARK_UNSYNCED)], docIndex)
  assert.deepEqual(
    hits.map((h) => [h.ocrStatus, h.ocrRate, h.ocrLowFolios, h.ocrLowFolioCount]),
    [
      [OCR_SYNC_STATUS.AVAILABLE, 0.7821, [2, 9], 2],
      [OCR_STATUS_PENDING, null, [], 0],
    ],
  )
  assert.equal(ocrNotice, RAG_OCR_LOW_NOTICE)
})

test("annotateKeywordHits: low folios capped at RAG_OCR_LOW_FOLIOS_MAX, count stays exact", () => {
  const many = Array.from({ length: RAG_OCR_LOW_FOLIOS_MAX + 5 }, (_, i) =>
    row({ folio: i + 1, ocrQuality: 0.5 }),
  )
  const docIndex = new Map([
    [ARK, toDocumentOcrView(ARK, { ark: ARK, status: OCR_SYNC_STATUS.AVAILABLE, ocrRate: null, reason: null, folios: many })],
  ])
  const [annotated] = annotateKeywordHits([hit(ARK)], docIndex).hits
  assert.equal(annotated.ocrLowFolios.length, RAG_OCR_LOW_FOLIOS_MAX)
  assert.deepEqual(annotated.ocrLowFolios.slice(0, 3), [1, 2, 3])
  assert.equal(annotated.ocrLowFolioCount, RAG_OCR_LOW_FOLIOS_MAX + 5)
})

test("docOcrSummary: scored folios exclude unscored and non-ALTO ones", () => {
  const summary = docOcrSummary(
    toDocumentOcrView(ARK, {
      ark: ARK,
      status: OCR_SYNC_STATUS.AVAILABLE,
      ocrRate: 0.7821,
      reason: null,
      folios: [F1, F2, F3, F4],
    }),
  )
  assert.deepEqual(summary, {
    status: OCR_SYNC_STATUS.AVAILABLE,
    ocrRate: 0.7821,
    scoredFolios: 3,
    lowFolios: [2],
    lowFolioCount: 1,
  })
})

// ---------------------------------------------------------------------------
// rag_get_text
// ---------------------------------------------------------------------------

test("annotateTextSlice: the folios whose heading is in the slice, leading folio unknown", () => {
  const slice = "…tail\n\n## Folio 3\n\nTexte\n\n## Folio 2\n\nTexte"
  const { ocr, ocrNotice } = annotateTextSlice(slice, ARK, INDEX)
  assert.deepEqual(ocr, {
    leadingFolioKnown: false,
    folios: [
      { folio: 3, ocrQuality: 0.8, ocrSource: "alto", ocrLow: false },
      { folio: 2, ocrQuality: 0.661, ocrSource: "alto", ocrLow: true },
    ],
  })
  assert.equal(ocrNotice, RAG_OCR_LOW_NOTICE)
})

test("annotateTextSlice: an unsynced folio heading → ocrSource null", () => {
  const { ocr, ocrNotice } = annotateTextSlice("## Folio 1\n\nx", ARK_UNSYNCED, INDEX)
  assert.deepEqual(ocr, {
    leadingFolioKnown: true,
    folios: [{ folio: 1, ocrQuality: null, ocrSource: null, ocrLow: false }],
  })
  assert.equal(ocrNotice, undefined)
})

// ---------------------------------------------------------------------------
// note_create / note_update / note_append
// ---------------------------------------------------------------------------

test("lowOcrForNoteResult: low valid text citations, deduped, with their quality", () => {
  const body =
    `[[${ARK}|A|2]] puis [[${ARK}|A|f2]] et [[${ARK}|A|1]] ` +
    `![[${ARK}|image|2]] [[${ARK_VISION}|V|1]]`
  assert.deepEqual(lowOcrForNoteResult(body, INDEX, []), [
    { ark: ARK, folio: 2, ocr_quality: 0.661 },
  ])
})

test("lowOcrForNoteResult: a rejected (not-in-corpus) ARK is never reported", () => {
  assert.deepEqual(lowOcrForNoteResult(`[[${ARK}|A|2]]`, INDEX, [ARK]), [])
})

test("the notices name the threshold from the constant, not a literal", () => {
  assert.match(RAG_OCR_LOW_NOTICE, /80 %/)
  assert.match(NOTE_LOW_OCR_NOTICE, /80 %/)
})
