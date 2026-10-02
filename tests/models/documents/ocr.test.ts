// tests/models/documents/ocr.test.ts
// The pure halves of the OCR-quality feature (feedback 2026-09-29 #7, Track B):
//
//   - toFolioOcrView / isLowOcr — the ONE "low OCR" decision (strict < the
//     threshold, unscored folios never low — plan D3/D10);
//   - workerOcrQualitySyncResponseSchema — the worker↔app wire contract (D2
//     invariants enforced in Zod, never trusted);
//   - planOcrSyncWrites — what DocumentService.recordOcrSync writes per ARK;
//   - toDocumentOcrView — "no row" reads as pending, never as "not low";
//   - lib/citations/ocr — the per-note low-citation selection (image embeds
//     excluded, D11) and the folio headings of a rag_get_text slice (D12).
//
// No Prisma, same precedent as tests/models/ingest/service.test.ts.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import { OCR_LOW_QUALITY_THRESHOLD } from "@/lib/constants"
import {
  folioOcrKey,
  foliosInSlice,
  indexFolioOcr,
  lowOcrCitations,
} from "@/lib/citations/ocr"
import {
  OCR_SOURCE,
  OCR_STATUS_PENDING,
  OCR_SYNC_STATUS,
  isLowOcr,
  toDocumentOcrView,
  toFolioOcrView,
  type DocumentFolioRow,
} from "@/models/documents/schema"
import { planOcrSyncWrites } from "@/models/documents/service"
import { workerOcrQualitySyncResponseSchema } from "@/models/documents/types"

const ARK = "ark:/12148/bpt6k841545p"
const ARK_VISION = "ark:/12148/btv1b100524476"
const ARK_GOLDEN = "ark:/12148/bpt6k4625753w"

function folioRow(over: Partial<DocumentFolioRow> = {}): DocumentFolioRow {
  return {
    ark: ARK,
    folio: 1,
    ocrSource: OCR_SOURCE.ALTO,
    ocrQuality: 0.9,
    wordCount: 100,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// The threshold boundary (D10)
// ---------------------------------------------------------------------------

test("the threshold is 0.8 (Leo, 2026-09-30)", () => {
  assert.equal(OCR_LOW_QUALITY_THRESHOLD, 0.8)
})

test("toFolioOcrView: 0.7999 is low", () => {
  assert.equal(toFolioOcrView(folioRow({ ocrQuality: 0.7999 })).low, true)
})

test("toFolioOcrView: 0.8 is NOT low (strict <)", () => {
  assert.equal(toFolioOcrView(folioRow({ ocrQuality: 0.8 })).low, false)
})

test("toFolioOcrView: an ALTO folio without a score is not low", () => {
  assert.equal(toFolioOcrView(folioRow({ ocrQuality: null })).low, false)
})

test("toFolioOcrView: mistral and vision folios are never low (D3)", () => {
  for (const ocrSource of [OCR_SOURCE.MISTRAL, OCR_SOURCE.VISION]) {
    const view = toFolioOcrView(folioRow({ ocrSource, ocrQuality: null, wordCount: null }))
    assert.equal(view.low, false)
    assert.equal(view.ocrSource, ocrSource)
  }
})

test("toFolioOcrView: carries the row through", () => {
  assert.deepEqual(toFolioOcrView(folioRow({ folio: 2, ocrQuality: 0.661, wordCount: 4016 })), {
    ark: ARK,
    folio: 2,
    ocrSource: OCR_SOURCE.ALTO,
    ocrQuality: 0.661,
    wordCount: 4016,
    low: true,
  })
})

test("toFolioOcrView: an unknown stored source is a corrupt row and throws", () => {
  assert.throws(() => toFolioOcrView(folioRow({ ocrSource: "tesseract" })), /tesseract/)
})

test("isLowOcr: null is never low", () => {
  assert.equal(isLowOcr(null), false)
  assert.equal(isLowOcr(0), true)
  assert.equal(isLowOcr(1), false)
})

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

/**
 * Copied from a real worker-v2 POST /ocr-quality/sync response (track-b dev
 * worker, 2026-10-01, logs/track-b/sync-last.json), trimmed to three folios.
 */
const WORKER_RESPONSE_FIXTURE = {
  documents: [
    {
      v: 1,
      ark: ARK_VISION,
      ocrRate: null,
      lane: "vision",
      folios: [{ ordre: 1, ocrSource: "vision", ocrQuality: null, wordCount: null }],
      builtAt: "2026-10-01T13:49:42.385Z",
    },
    {
      v: 1,
      ark: ARK,
      ocrRate: 0.8924,
      lane: "text",
      folios: [
        { ordre: 1, ocrSource: "alto", ocrQuality: 0.7031, wordCount: 175 },
        { ordre: 4, ocrSource: "alto", ocrQuality: 0.8024, wordCount: 274 },
        { ordre: 11, ocrSource: "alto", ocrQuality: 0.7354, wordCount: 47 },
      ],
      builtAt: "2026-10-01T13:49:53.149Z",
    },
  ],
  building: [],
  unavailable: [],
}

function withFolio(folio: Record<string, unknown>, lane = "text") {
  return {
    documents: [{ v: 1, ark: ARK, ocrRate: 0.5, lane, folios: [folio], builtAt: "2026-10-01T13:49:53.149Z" }],
    building: [],
    unavailable: [],
  }
}

test("schema: accepts the real worker response", () => {
  const parsed = workerOcrQualitySyncResponseSchema.safeParse(WORKER_RESPONSE_FIXTURE)
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
})

test("schema: rejects an alto folio with wordCount null", () => {
  const r = workerOcrQualitySyncResponseSchema.safeParse(
    withFolio({ ordre: 1, ocrSource: "alto", ocrQuality: 0.9, wordCount: null }),
  )
  assert.equal(r.success, false)
})

test("schema: rejects ocrQuality 1.2", () => {
  const r = workerOcrQualitySyncResponseSchema.safeParse(
    withFolio({ ordre: 1, ocrSource: "alto", ocrQuality: 1.2, wordCount: 10 }),
  )
  assert.equal(r.success, false)
})

test("schema: rejects a mistral folio with a quality", () => {
  const r = workerOcrQualitySyncResponseSchema.safeParse(
    withFolio({ ordre: 1, ocrSource: "mistral", ocrQuality: 0.5, wordCount: null }, "mistral"),
  )
  assert.equal(r.success, false)
})

test("schema: rejects a vision folio with a word count", () => {
  const r = workerOcrQualitySyncResponseSchema.safeParse(
    withFolio({ ordre: 1, ocrSource: "vision", ocrQuality: null, wordCount: 3 }, "vision"),
  )
  assert.equal(r.success, false)
})

test("schema: rejects an ocrRate above 1", () => {
  const r = workerOcrQualitySyncResponseSchema.safeParse({
    ...WORKER_RESPONSE_FIXTURE,
    documents: [{ ...WORKER_RESPONSE_FIXTURE.documents[1], ocrRate: 78.21 }],
  })
  assert.equal(r.success, false)
})

test("schema: rejects a folio whose source contradicts the lane", () => {
  const r = workerOcrQualitySyncResponseSchema.safeParse(
    withFolio({ ordre: 1, ocrSource: "vision", ocrQuality: null, wordCount: null }, "text"),
  )
  assert.equal(r.success, false)
})

test("schema: rejects a duplicate folio", () => {
  const folio = { ordre: 2, ocrSource: "alto", ocrQuality: 0.5, wordCount: 3 }
  const r = workerOcrQualitySyncResponseSchema.safeParse({
    documents: [{ v: 1, ark: ARK, ocrRate: null, lane: "text", folios: [folio, folio], builtAt: "2026-10-01T13:49:53.149Z" }],
    building: [],
    unavailable: [],
  })
  assert.equal(r.success, false)
})

test("schema: rejects an ARK reported in two buckets", () => {
  const r = workerOcrQualitySyncResponseSchema.safeParse({
    ...WORKER_RESPONSE_FIXTURE,
    building: [ARK],
  })
  assert.equal(r.success, false)
})

test("schema: rejects an unavailable entry without a reason", () => {
  const r = workerOcrQualitySyncResponseSchema.safeParse({
    documents: [],
    building: [],
    unavailable: [{ ark: ARK, reason: "" }],
  })
  assert.equal(r.success, false)
})

// ---------------------------------------------------------------------------
// planOcrSyncWrites
// ---------------------------------------------------------------------------

test("planOcrSyncWrites: the exact replace / status plan", () => {
  const now = new Date("2026-10-02T09:00:00Z")
  const response = workerOcrQualitySyncResponseSchema.parse({
    documents: [WORKER_RESPONSE_FIXTURE.documents[1]],
    building: [ARK_GOLDEN],
    unavailable: [{ ark: ARK_VISION, reason: "no_pages_artifact" }],
  })
  assert.deepEqual(planOcrSyncWrites(response, now), {
    checkedAt: now,
    available: [
      {
        ark: ARK,
        ocrRate: 0.8924,
        folios: [
          { folio: 1, ocrSource: "alto", ocrQuality: 0.7031, wordCount: 175 },
          { folio: 4, ocrSource: "alto", ocrQuality: 0.8024, wordCount: 274 },
          { folio: 11, ocrSource: "alto", ocrQuality: 0.7354, wordCount: 47 },
        ],
      },
    ],
    building: [ARK_GOLDEN],
    unavailable: [{ ark: ARK_VISION, reason: "no_pages_artifact" }],
  })
})

test("planOcrSyncWrites: an empty response plans nothing", () => {
  const now = new Date("2026-10-02T09:00:00Z")
  assert.deepEqual(
    planOcrSyncWrites({ documents: [], building: [], unavailable: [] }, now),
    { checkedAt: now, available: [], building: [], unavailable: [] },
  )
})

// ---------------------------------------------------------------------------
// toDocumentOcrView
// ---------------------------------------------------------------------------

test("toDocumentOcrView: no row is pending, with no folios", () => {
  assert.deepEqual(toDocumentOcrView(ARK, null), {
    ark: ARK,
    status: OCR_STATUS_PENDING,
    ocrRate: null,
    reason: null,
    folios: [],
  })
})

test("toDocumentOcrView: an available row with its folios, ordered", () => {
  const view = toDocumentOcrView(ARK, {
    ark: ARK,
    status: OCR_SYNC_STATUS.AVAILABLE,
    ocrRate: 0.7821,
    reason: null,
    folios: [folioRow({ folio: 2, ocrQuality: 0.661 }), folioRow({ folio: 1, ocrQuality: 0.932 })],
  })
  assert.equal(view.status, OCR_SYNC_STATUS.AVAILABLE)
  assert.equal(view.ocrRate, 0.7821)
  assert.deepEqual(
    view.folios.map((f) => [f.folio, f.low]),
    [
      [1, false],
      [2, true],
    ],
  )
})

test("toDocumentOcrView: an unknown stored status is a corrupt row and throws", () => {
  assert.throws(
    () => toDocumentOcrView(ARK, { ark: ARK, status: "done", ocrRate: null, reason: null, folios: [] }),
    /done/,
  )
})

// ---------------------------------------------------------------------------
// lib/citations/ocr
// ---------------------------------------------------------------------------

const GOLDEN_INDEX = indexFolioOcr([
  toFolioOcrView(folioRow({ ark: ARK_GOLDEN, folio: 1, ocrQuality: 0.932, wordCount: 5106 })),
  toFolioOcrView(folioRow({ ark: ARK_GOLDEN, folio: 2, ocrQuality: 0.661, wordCount: 4016 })),
  toFolioOcrView(folioRow({ ark: ARK_VISION, folio: 1, ocrSource: OCR_SOURCE.VISION, ocrQuality: null, wordCount: null })),
])

test("indexFolioOcr: keyed by (ark, folio)", () => {
  assert.equal(GOLDEN_INDEX.get(folioOcrKey(ARK_GOLDEN, 2))?.ocrQuality, 0.661)
  assert.equal(GOLDEN_INDEX.get(folioOcrKey(ARK_GOLDEN, 3)), undefined)
})

test("lowOcrCitations: f2 (0.661) is low, f1 (0.932) is not", () => {
  const body = `Voir [[${ARK_GOLDEN}|L'Auto-vélo|1]] et [[${ARK_GOLDEN}|L'Auto-vélo|f2]].`
  const low = lowOcrCitations(body, GOLDEN_INDEX)
  assert.deepEqual(
    low.map((c) => [c.ark, c.folio]),
    [[ARK_GOLDEN, 2]],
  )
})

test("lowOcrCitations: a note citing only f1 has none", () => {
  assert.deepEqual(lowOcrCitations(`[[${ARK_GOLDEN}|L'Auto-vélo|1]]`, GOLDEN_INDEX), [])
})

test("lowOcrCitations: image embeds never count (D11)", () => {
  assert.deepEqual(lowOcrCitations(`![[${ARK_GOLDEN}|Une|2]]`, GOLDEN_INDEX), [])
})

test("lowOcrCitations: vision and unsynced folios are not low", () => {
  const body = `[[${ARK_VISION}|Estampe|1]] [[${ARK}|Inconnu|9]]`
  assert.deepEqual(lowOcrCitations(body, GOLDEN_INDEX), [])
})

test("foliosInSlice: the headings inside the slice, in order", () => {
  const slice = "…tail of folio 2\n\n## Folio 3\n\nTexte trois\n\n## Folio 4\n\nTexte quatre"
  assert.deepEqual(foliosInSlice(slice), { folios: [3, 4], leadingFolioKnown: false })
})

test("foliosInSlice: a slice that starts on a heading knows its leading folio", () => {
  assert.deepEqual(foliosInSlice("## Folio 1\n\nTexte"), { folios: [1], leadingFolioKnown: true })
})

test("foliosInSlice: no heading at all", () => {
  assert.deepEqual(foliosInSlice("milieu d'une page"), { folios: [], leadingFolioKnown: false })
})

test("foliosInSlice: is stable across calls (the shared /g regex is never .exec'd)", () => {
  const slice = "## Folio 7\n\nx\n\n## Folio 8\n\ny"
  assert.deepEqual(foliosInSlice(slice), foliosInSlice(slice))
  assert.deepEqual(foliosInSlice(slice).folios, [7, 8])
})

test("foliosInSlice: a heading-like line inside a paragraph is not a heading", () => {
  assert.deepEqual(foliosInSlice("texte ## Folio 3 suite"), { folios: [], leadingFolioKnown: false })
})
