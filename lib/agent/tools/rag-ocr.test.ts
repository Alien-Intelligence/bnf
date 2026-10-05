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
import { OCR_INDEX_CHECK_FAILED, OCR_INDEX_REVOKED, buildOcrIndex, toDocumentOcrView } from "@/lib/ocr/quality"
import { parseCitations } from "@/lib/citations/syntax"
import {
  DOCUMENT_OCR_STATUS,
  FOLIO_OCR_STATE,
  OCR_SOURCE,
  OCR_SYNC_STATUS,
  type DocumentFolioRow,
} from "@/models/documents/schema"

import {
  DOCUMENT_OCR_STATUS_LEGEND,
  DOCUMENT_OCR_STATUS_MEANING,
  FOLIO_OCR_STATE_LEGEND,
  FOLIO_OCR_STATE_MEANING,
  NOTE_LOW_OCR_NOTICE,
  NOTE_OCR_UNKNOWN_NOTICE,
  RAG_KEYWORD_OCR_LOW_NOTICE,
  RAG_OCR_LOW_NOTICE,
  ocrLowNotices,
} from "./constants"
import {
  annotateKeywordHits,
  annotatePassages,
  annotateTextSlice,
  CorpusRevokedReadError,
  docOcrSummary,
  loadDocOcrIndex,
  loadDocOcrSummary,
  noteOcrReport,
} from "./rag-ocr"

const ARK = "ark:/12148/bpt6k4625753w"
const ARK_VISION = "ark:/12148/btv1b100524476"
const ARK_UNSYNCED = "ark:/12148/bpt6k000001"
const ARK_BUILDING = "ark:/12148/bpt6k000002"
const ARK_UNAVAILABLE = "ark:/12148/bpt6k000003"
const ARK_QUARANTINED = "ark:/12148/bpt6k000004"

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
    { ark: ARK_UNAVAILABLE, status: OCR_SYNC_STATUS.UNAVAILABLE },
    { ark: ARK_QUARANTINED, status: OCR_SYNC_STATUS.QUARANTINED },
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

test("annotatePassages: not yet, never-for-this-folio, not obtained and no folio stay apart", () => {
  const { passages, ocrNotice } = annotatePassages(
    [
      passage({ folio: null }),
      passage({ ark: ARK_UNSYNCED, folio: 3 }),
      passage({ ark: ARK_BUILDING, folio: 3 }),
      passage({ ark: ARK_UNAVAILABLE, folio: 3 }),
      passage({ ark: ARK_QUARANTINED, folio: 3 }),
      passage({ folio: 99 }),
      passage({ ark: ARK_VISION, folio: 1 }),
    ],
    INDEX,
  )
  assert.deepEqual(
    passages.map((p) => [p.ocrState, p.ocrSource, p.ocrLow]),
    [
      [FOLIO_OCR_STATE.NO_FOLIO, null, false],
      [FOLIO_OCR_STATE.PENDING, null, false],
      [FOLIO_OCR_STATE.PENDING, null, false],
      [FOLIO_OCR_STATE.UNAVAILABLE, null, false],
      [FOLIO_OCR_STATE.UNAVAILABLE, null, false],
      [FOLIO_OCR_STATE.NOT_RECORDED, null, false],
      [FOLIO_OCR_STATE.RECORDED, "vision", false],
    ],
  )
  assert.equal(ocrNotice, undefined)
})

test("annotatePassages: a revoked or failed index marks every folio so, never as recorded", () => {
  for (const [index, kind] of [
    [OCR_INDEX_REVOKED, FOLIO_OCR_STATE.CORPUS_REVOKED],
    [OCR_INDEX_CHECK_FAILED, FOLIO_OCR_STATE.CHECK_FAILED],
  ] as const) {
    const { passages } = annotatePassages([passage({ folio: 2 }), passage({ folio: null })], index)
    assert.deepEqual(
      passages.map((p) => [p.ocrState, p.ocrQuality, p.ocrLow]),
      [
        [kind, null, false],
        [FOLIO_OCR_STATE.NO_FOLIO, null, false],
      ],
    )
  }
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
      // Not synced: the counts are UNKNOWN (null), never "no low folio" (0).
      [DOCUMENT_OCR_STATUS.PENDING, null, null, null],
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
  assert.equal(annotated.ocrLowFolios?.length, RAG_OCR_LOW_FOLIOS_MAX)
  assert.deepEqual(annotated.ocrLowFolios?.slice(0, 3), [1, 2, 3])
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

test("docOcrSummary: counts are null unless available — a building row's old folios do not count", () => {
  // A `building` row that was once available still holds folios: its counts
  // would be stale, so they are unknown until the new artifact lands.
  for (const status of [
    OCR_SYNC_STATUS.BUILDING,
    OCR_SYNC_STATUS.UNAVAILABLE,
    OCR_SYNC_STATUS.QUARANTINED,
  ]) {
    assert.deepEqual(
      docOcrSummary(toDocumentOcrView(ARK, { ark: ARK, status, ocrRate: 0.5, reason: null, folios: [F2] })),
      { status, ocrRate: 0.5, scoredFolios: null, lowFolios: null, lowFolioCount: null },
    )
  }
  assert.deepEqual(docOcrSummary(toDocumentOcrView(ARK, null)), {
    status: DOCUMENT_OCR_STATUS.PENDING,
    ocrRate: null,
    scoredFolios: null,
    lowFolios: null,
    lowFolioCount: null,
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
      { folio: 3, ocrState: "recorded", ocrQuality: OCR_LOW_QUALITY_THRESHOLD, ocrSource: "alto", ocrLow: false },
      { folio: 2, ocrState: "recorded", ocrQuality: 0.661, ocrSource: "alto", ocrLow: true },
    ],
  })
  assert.equal(ocrNotice, RAG_OCR_LOW_NOTICE)
})

test("annotateTextSlice: an unsynced folio heading → pending", () => {
  const { ocr, ocrNotice } = annotateTextSlice("## Folio 1\n\nx", ARK_UNSYNCED, INDEX)
  assert.deepEqual(ocr, {
    leadingFolioKnown: true,
    folios: [{ folio: 1, ocrState: FOLIO_OCR_STATE.PENDING, ocrQuality: null, ocrSource: null, ocrLow: false }],
  })
  assert.equal(ocrNotice, undefined)
})

// ---------------------------------------------------------------------------
// note results
// ---------------------------------------------------------------------------

/** The corpus-vouched text citations of a body (no ARK rejected), as note writes report them. */
function refs(body: string) {
  return parseCitations(body)
}

test("noteOcrReport: low and unknown citations, deduped, with their quality / state", () => {
  const body =
    `[[${ARK}|A|2]] puis [[${ARK}|A|f2]] et [[${ARK}|A|1]] ` +
    `[[${ARK_VISION}|V|1]] [[${ARK_UNSYNCED}|U|5]] [[${ARK}|absent|99]] [[${ARK_QUARANTINED}|Q|1]]`
  assert.deepEqual(noteOcrReport(refs(body), INDEX), {
    low: [{ ark: ARK, folio: 2, ocr_quality: 0.661 }],
    unknown: [
      { ark: ARK_UNSYNCED, folio: 5, ocr_state: FOLIO_OCR_STATE.PENDING },
      { ark: ARK, folio: 99, ocr_state: FOLIO_OCR_STATE.NOT_RECORDED },
      { ark: ARK_QUARANTINED, folio: 1, ocr_state: FOLIO_OCR_STATE.UNAVAILABLE },
    ],
  })
})

test("noteOcrReport: an image embed of a low folio cited nowhere else is excluded (D11)", () => {
  // f2 is low; it appears ONLY as an image embed here, so nothing is reported.
  assert.deepEqual(noteOcrReport(refs(`![[${ARK}|Une|2]] [[${ARK}|A|1]]`), INDEX), {
    low: [],
    unknown: [],
  })
})

test("noteOcrReport: Citation rows (a note read) — a row without a folio is skipped", () => {
  assert.deepEqual(
    noteOcrReport(
      [
        { ark: ARK, folio: 2 },
        { ark: ARK, folio: null },
      ],
      INDEX,
    ),
    { low: [{ ark: ARK, folio: 2, ocr_quality: 0.661 }], unknown: [] },
  )
})

// ---------------------------------------------------------------------------
// The model-facing wording
// ---------------------------------------------------------------------------

test("the low notices are built from the threshold they are given", () => {
  // A builder fed another threshold must say that percentage and not the
  // production one: a hard-coded "80 %" fails here.
  const half = ocrLowNotices(0.5)
  for (const notice of [half.rag, half.keyword, half.note]) {
    assert.ok(notice.includes("50 %"), notice)
    assert.ok(!notice.includes("80 %"), notice)
  }
  const prod = ocrLowNotices(OCR_LOW_QUALITY_THRESHOLD)
  assert.deepEqual([prod.rag, prod.keyword, prod.note], [RAG_OCR_LOW_NOTICE, RAG_KEYWORD_OCR_LOW_NOTICE, NOTE_LOW_OCR_NOTICE])
})

test("every folio state and document status has its meaning in the legends", () => {
  for (const kind of Object.values(FOLIO_OCR_STATE)) {
    assert.ok(FOLIO_OCR_STATE_LEGEND.includes(`\`${kind}\` — ${FOLIO_OCR_STATE_MEANING[kind]}`), kind)
  }
  for (const status of Object.values(DOCUMENT_OCR_STATUS)) {
    assert.ok(
      DOCUMENT_OCR_STATUS_LEGEND.includes(`\`${status}\` — ${DOCUMENT_OCR_STATUS_MEANING[status]}`),
      status,
    )
  }
})

test("not_recorded is permanent, unavailable 'may never be', quarantined is retried (never terminal)", () => {
  assert.match(FOLIO_OCR_STATE_MEANING[FOLIO_OCR_STATE.NOT_RECORDED], /définitivement/)
  assert.doesNotMatch(FOLIO_OCR_STATE_MEANING[FOLIO_OCR_STATE.NOT_RECORDED], /pas encore/)
  assert.match(FOLIO_OCR_STATE_MEANING[FOLIO_OCR_STATE.PENDING], /pas encore/)
  // Only `unavailable` (BnF does not provide it) may never be available…
  assert.match(DOCUMENT_OCR_STATUS_MEANING[DOCUMENT_OCR_STATUS.UNAVAILABLE], /ne jamais/)
  // …a quarantine is a long backoff (pass 6): retried, never "never".
  assert.match(DOCUMENT_OCR_STATUS_MEANING[DOCUMENT_OCR_STATUS.QUARANTINED], /réessayée/)
  assert.doesNotMatch(DOCUMENT_OCR_STATUS_MEANING[DOCUMENT_OCR_STATUS.QUARANTINED], /jamais/)
  // The folio state carrying both says which is which.
  assert.match(FOLIO_OCR_STATE_MEANING[FOLIO_OCR_STATE.UNAVAILABLE], /`unavailable` — .*ne jamais/)
  assert.match(FOLIO_OCR_STATE_MEANING[FOLIO_OCR_STATE.UNAVAILABLE], /`quarantined` — .*réessayée/)
  // The unknown-citations notice explains each state a note can report.
  for (const kind of [FOLIO_OCR_STATE.PENDING, FOLIO_OCR_STATE.UNAVAILABLE, FOLIO_OCR_STATE.NOT_RECORDED]) {
    assert.ok(NOTE_OCR_UNKNOWN_NOTICE.includes(`\`${kind}\``), kind)
  }
})

test("the document-level loaders refuse a revoked reader before any read", async () => {
  const revoked = { corpusProjectId: "no-such-project", corpusReachable: false, signal: AbortSignal.abort() }
  await assert.rejects(loadDocOcrIndex(revoked, [ARK]), CorpusRevokedReadError)
  await assert.rejects(loadDocOcrSummary(revoked, ARK), CorpusRevokedReadError)
})
