// lib/agent/tools/rag-ocr.test.ts
// The pure annotators that put OCR quality into the agent's corpus tool
// results (feedback 2026-09-29 #7, Track B, Phase 5). The model must SEE that a
// folio is poorly recognised — ocrLow is computed by code (isLowOcr), never
// left to the prompt — and must never mistake "not known" for "fine": every
// folio carries its ocrState.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import { OCR_LOW_QUALITY_THRESHOLD, RAG_OCR_LOW_FOLIOS_MAX } from "@/lib/constants"
import type { RagKeywordHit, RagPassage } from "@/lib/cluster/rag"
import { buildOcrIndex, ocrPercent, toDocumentOcrView } from "@/lib/ocr/quality"
import {
  OCR_SOURCE,
  OCR_STATUS_PENDING,
  OCR_SYNC_STATUS,
  type DocumentFolioRow,
} from "@/models/documents/schema"

import { NOTE_LOW_OCR_NOTICE, RAG_KEYWORD_OCR_LOW_NOTICE, RAG_OCR_LOW_NOTICE } from "./constants"
import {
  annotateKeywordHits,
  annotatePassages,
  annotateTextSlice,
  docOcrSummary,
  noteOcrReport,
} from "./rag-ocr"

const ARK = "ark:/12148/bpt6k4625753w"
const ARK_VISION = "ark:/12148/btv1b100524476"
const ARK_UNSYNCED = "ark:/12148/bpt6k000001"
const ARK_BUILDING = "ark:/12148/bpt6k000002"

function row(over: Partial<DocumentFolioRow>): DocumentFolioRow {
  return { ark: ARK, folio: 1, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.9, wordCount: 10, ...over }
}

const F1 = row({ folio: 1, ocrQuality: 0.932, wordCount: 5106 })
const F2 = row({ folio: 2, ocrQuality: 0.661, wordCount: 4016 })
const F3 = row({ folio: 3, ocrQuality: OCR_LOW_QUALITY_THRESHOLD, wordCount: 3000 })
const F4 = row({ folio: 4, ocrQuality: null, wordCount: 12 })
const V1 = row({ ark: ARK_VISION, folio: 1, ocrSource: OCR_SOURCE.VISION, ocrQuality: null, wordCount: null })

const INDEX = buildOcrIndex(
  [F1, F2, F3, F4, V1],
  [
    { ark: ARK, status: OCR_SYNC_STATUS.AVAILABLE },
    { ark: ARK_VISION, status: OCR_SYNC_STATUS.AVAILABLE },
    { ark: ARK_BUILDING, status: OCR_SYNC_STATUS.BUILDING },
  ],
)

function passage(over: Partial<RagPassage>): RagPassage {
  return { ark: ARK, folio: 1, snippet: "…", score: 0.5, charRange: [0, 10], entryId: 7, ...over }
}

// ---------------------------------------------------------------------------
// rag_query
// ---------------------------------------------------------------------------

test("annotatePassages: state, quality, source and low per (ark, folio)", () => {
  const { passages, ocrNotice } = annotatePassages([passage({ folio: 1 }), passage({ folio: 2 })], INDEX)
  assert.deepEqual(
    passages.map((p) => [p.folio, p.ocrState, p.ocrQuality, p.ocrSource, p.ocrLow]),
    [
      [1, "recorded", 0.932, "alto", false],
      [2, "recorded", 0.661, "alto", true],
    ],
  )
  assert.equal(ocrNotice, RAG_OCR_LOW_NOTICE)
})

test("annotatePassages: the passage itself is kept as is", () => {
  const p = passage({ folio: 2, title: "L'Auto-vélo", year: 1910 })
  const [annotated] = annotatePassages([p], INDEX).passages
  const { ocrState: _s, ocrQuality: _q, ocrSource: _o, ocrLow: _l, ...rest } = annotated
  assert.deepEqual(rest, p)
})

test("annotatePassages: no folio, not synced, building and not recorded are four different states", () => {
  const { passages, ocrNotice } = annotatePassages(
    [
      passage({ folio: null }),
      passage({ ark: ARK_UNSYNCED, folio: 3 }),
      passage({ ark: ARK_BUILDING, folio: 3 }),
      passage({ folio: 99 }),
      passage({ ark: ARK_VISION, folio: 1 }),
    ],
    INDEX,
  )
  assert.deepEqual(
    passages.map((p) => [p.ocrState, p.ocrSource, p.ocrLow]),
    [
      ["no_folio", null, false],
      ["not_synced", null, false],
      ["not_synced", null, false],
      ["not_recorded", null, false],
      ["recorded", "vision", false],
    ],
  )
  assert.equal(ocrNotice, undefined)
})

test("annotatePassages: the threshold itself is not low → no notice", () => {
  const { ocrNotice } = annotatePassages([passage({ folio: 1 }), passage({ folio: 3 })], INDEX)
  assert.equal(ocrNotice, undefined)
})

// ---------------------------------------------------------------------------
// rag_keyword_search
// ---------------------------------------------------------------------------

function hit(ark: string): RagKeywordHit {
  return { ark, entryId: 1, title: "t", date: null, score: 1, snippets: ["s"] }
}

test("annotateKeywordHits: status, ocrRate, sorted low folios and their count", () => {
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
  // Keyword hits have no ocrLow field: their notice names the fields they DO have.
  assert.equal(ocrNotice, RAG_KEYWORD_OCR_LOW_NOTICE)
  assert.match(RAG_KEYWORD_OCR_LOW_NOTICE, /ocrLowFolios/)
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
  assert.deepEqual(
    docOcrSummary(
      toDocumentOcrView(ARK, {
        ark: ARK,
        status: OCR_SYNC_STATUS.AVAILABLE,
        ocrRate: 0.7821,
        reason: null,
        folios: [F1, F2, F3, F4],
      }),
    ),
    { status: OCR_SYNC_STATUS.AVAILABLE, ocrRate: 0.7821, scoredFolios: 3, lowFolios: [2], lowFolioCount: 1 },
  )
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
      { folio: 3, ocrState: "recorded", ocrQuality: OCR_LOW_QUALITY_THRESHOLD, ocrSource: "alto", ocrLow: false },
      { folio: 2, ocrState: "recorded", ocrQuality: 0.661, ocrSource: "alto", ocrLow: true },
    ],
  })
  assert.equal(ocrNotice, RAG_OCR_LOW_NOTICE)
})

test("annotateTextSlice: an unsynced folio heading → not_synced", () => {
  const { ocr, ocrNotice } = annotateTextSlice("## Folio 1\n\nx", ARK_UNSYNCED, INDEX)
  assert.deepEqual(ocr, {
    leadingFolioKnown: true,
    folios: [{ folio: 1, ocrState: "not_synced", ocrQuality: null, ocrSource: null, ocrLow: false }],
  })
  assert.equal(ocrNotice, undefined)
})

// ---------------------------------------------------------------------------
// note results
// ---------------------------------------------------------------------------

test("noteOcrReport: low and unknown citations, deduped, with their quality / state", () => {
  const body =
    `[[${ARK}|A|2]] puis [[${ARK}|A|f2]] et [[${ARK}|A|1]] ` +
    `[[${ARK_VISION}|V|1]] [[${ARK_UNSYNCED}|U|5]] [[${ARK}|absent|99]]`
  assert.deepEqual(noteOcrReport(body, INDEX, []), {
    low: [{ ark: ARK, folio: 2, ocr_quality: 0.661 }],
    unknown: [
      { ark: ARK_UNSYNCED, folio: 5, ocr_state: "not_synced" },
      { ark: ARK, folio: 99, ocr_state: "not_recorded" },
    ],
  })
})

test("noteOcrReport: an image embed of a low folio cited nowhere else is excluded (D11)", () => {
  // f2 is low; it appears ONLY as an image embed here, so nothing is reported.
  assert.deepEqual(noteOcrReport(`![[${ARK}|Une|2]] [[${ARK}|A|1]]`, INDEX, []), {
    low: [],
    unknown: [],
  })
})

test("noteOcrReport: a rejected (not-in-corpus) ARK is never reported", () => {
  assert.deepEqual(noteOcrReport(`[[${ARK}|A|2]] [[${ARK_UNSYNCED}|U|1]]`, INDEX, [ARK, ARK_UNSYNCED]), {
    low: [],
    unknown: [],
  })
})

test("the notices derive their percentage from the threshold constant", () => {
  const pct = `${ocrPercent(OCR_LOW_QUALITY_THRESHOLD)} %`
  assert.ok(RAG_OCR_LOW_NOTICE.includes(pct))
  assert.ok(RAG_KEYWORD_OCR_LOW_NOTICE.includes(pct))
  assert.ok(NOTE_LOW_OCR_NOTICE.includes(pct))
})
