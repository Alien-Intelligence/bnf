// models/documents/outcome.test.ts
// classifyOutcome + indexationReasonKey — the derivation behind the corpus
// « non indexés » mark and filter. Pure functions over hand-built rows, the
// same precedent as tests/models/ingest/service.test.ts: no Prisma, because the
// codebase has no pattern for mocking it.
//
// What these guard is a false NEGATIVE, which is the failure mode of the whole
// feature: a document that is missing from the index but reads as `indexed`
// disappears from the mark, from the filter and from the header count at once,
// and the corpus goes back to looking complete when it is not.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  DOCUMENT_RESOLVE_STATUS,
  INDEXATION_OUTCOME,
  classifyOutcome,
  indexationReasonKey,
  indexationWarning,
} from "@/models/documents/schema"

const INDEXED_AT = new Date("2026-09-20T10:00:00Z")

/** A resolved, digitized document with an OCR layer — the ingestable base case. */
function ingestableDoc(over: Partial<Parameters<typeof classifyOutcome>[0]> = {}) {
  return {
    indexedAt: null,
    indexError: null,
    docType: "book",
    ocrAvailable: true,
    digitized: true,
    resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// The four states
// ---------------------------------------------------------------------------

test("indexedAt set → indexed", () => {
  assert.equal(
    classifyOutcome(ingestableDoc({ indexedAt: INDEXED_AT })),
    INDEXATION_OUTCOME.INDEXED,
  )
})

test("never indexed with a recorded reason → failed", () => {
  assert.equal(
    classifyOutcome(ingestableDoc({ indexError: "rate_limited" })),
    INDEXATION_OUTCOME.FAILED,
  )
})

test("ingestable, never sent, no error → not_ingested", () => {
  assert.equal(classifyOutcome(ingestableDoc()), INDEXATION_OUTCOME.NOT_INGESTED)
})

test("resolved digitized document with no text layer → excluded", () => {
  assert.equal(
    classifyOutcome(ingestableDoc({ ocrAvailable: false })),
    INDEXATION_OUTCOME.EXCLUDED,
  )
})

test("undigitized notice → excluded, resolution status irrelevant", () => {
  // A catalogue notice has no scan to resolve, so the verdict is already final
  // while it is still pending — mirroring _partitionByIngestability's
  // `!digitized || resolved` confidence guard.
  for (const resolveStatus of [
    DOCUMENT_RESOLVE_STATUS.PENDING,
    DOCUMENT_RESOLVE_STATUS.RESOLVED,
    DOCUMENT_RESOLVE_STATUS.FAILED,
  ]) {
    assert.equal(
      classifyOutcome(ingestableDoc({ digitized: false, resolveStatus })),
      INDEXATION_OUTCOME.EXCLUDED,
      `resolveStatus ${resolveStatus}`,
    )
  }
})

// ---------------------------------------------------------------------------
// The two ways this silently lies
// ---------------------------------------------------------------------------

test("indexed WITH a warning is indexed, not failed", () => {
  // IngestService.commit stamps indexedAt AND leaves a warning reason on the
  // same row (the F13 partial-transcription annotation). Reading that row as
  // `failed` would file a retrievable document under "missing from the index"
  // and send the librarian hunting for a document the agent can already cite.
  const doc = ingestableDoc({
    indexedAt: INDEXED_AT,
    indexError: "page-fail-ratio 1/40 > 0.02",
  })
  assert.equal(classifyOutcome(doc), INDEXATION_OUTCOME.INDEXED)
  assert.equal(indexationWarning(doc), "page-fail-ratio 1/40 > 0.02")
})

test("a warning is only a warning on an indexed row", () => {
  // On a failed row the reason IS the failure; surfacing it as a warning too
  // would double-count it in the UI.
  assert.equal(
    indexationWarning(ingestableDoc({ indexError: "assemble_no_text" })),
    null,
  )
})

test("unresolved digitized stub is not_ingested, never excluded", () => {
  // ocrAvailable is null until the BnF lookup lands, which classifies as
  // sans_texte — but the lookup may yet report an OCR layer. Calling it
  // `excluded` asserts a permanent absence from a pending read, and the
  // document would be marked un-indexable forever on the strength of a
  // metadata call that had not returned yet.
  assert.equal(
    classifyOutcome(
      ingestableDoc({
        ocrAvailable: null,
        resolveStatus: DOCUMENT_RESOLVE_STATUS.PENDING,
      }),
    ),
    INDEXATION_OUTCOME.NOT_INGESTED,
  )
})

test("precedence: indexedAt beats indexError beats the ingestability class", () => {
  // The order of the three checks IS the rule, and every way of getting it wrong
  // produces a plausible-looking classifier that mislabels a real row. Each case
  // below sets up a document that satisfies MORE THAN ONE arm and asserts which
  // one wins, so reordering the checks fails here rather than in production.
  const cases = [
    {
      why: "indexed with a warning: indexedAt wins over a set indexError",
      doc: ingestableDoc({ indexedAt: INDEXED_AT, indexError: "boom" }),
      expect: INDEXATION_OUTCOME.INDEXED,
    },
    {
      why: "indexed despite never having been ingestable (paid-OCR path)",
      doc: ingestableDoc({ indexedAt: INDEXED_AT, ocrAvailable: false }),
      expect: INDEXATION_OUTCOME.INDEXED,
    },
    {
      why: "failed wins over excluded: it was sent, whatever its class says",
      doc: ingestableDoc({ indexError: "rate_limited", ocrAvailable: false }),
      expect: INDEXATION_OUTCOME.FAILED,
    },
    {
      why: "failed wins over excluded for an undigitized row too",
      doc: ingestableDoc({ indexError: "rate_limited", digitized: false }),
      expect: INDEXATION_OUTCOME.FAILED,
    },
  ]
  for (const c of cases) {
    assert.equal(classifyOutcome(c.doc), c.expect, c.why)
  }
})

test("every state is reachable, and the classifier is total", () => {
  // Totality over the real table is asserted in tests/models/corpus/
  // indexation.test.ts, which checks the four SQL predicates partition a real
  // corpus. This is the cheap in-process counterpart: no combination of the
  // inputs falls through the classifier without producing one of the four.
  const seen = new Set<string>()
  for (const indexedAt of [null, INDEXED_AT]) {
    for (const indexError of [null, "boom"]) {
      for (const ocrAvailable of [true, false, null]) {
        for (const digitized of [true, false]) {
          for (const docType of ["book", "image", null]) {
            for (const resolveStatus of Object.values(DOCUMENT_RESOLVE_STATUS)) {
              seen.add(
                classifyOutcome({
                  indexedAt,
                  indexError,
                  docType,
                  ocrAvailable,
                  digitized,
                  resolveStatus,
                }),
              )
            }
          }
        }
      }
    }
  }
  assert.deepEqual([...seen].sort(), [...Object.values(INDEXATION_OUTCOME)].sort())
})

// ---------------------------------------------------------------------------
// Reason labels
// ---------------------------------------------------------------------------

test("reason keys match the leading token, not the whole string", () => {
  // The worker appends its detail, so every reason that carries any would fall
  // through to the raw machine string if we matched on equality — which is most
  // of them, and which is exactly what "raw worker strings are not acceptable
  // UI copy" forbids.
  assert.equal(indexationReasonKey("page-fail-ratio 3/4 > 0.5"), "partialPages")
  assert.equal(
    indexationReasonKey("embed_failed_after_retries: 429 Too Many Requests"),
    "indexFailed",
  )
  assert.equal(indexationReasonKey("ocr_batch_failed: upstream 500"), "ocrFailed")
})

test("bare tokens still resolve", () => {
  assert.equal(indexationReasonKey("assemble_no_text"), "noText")
  assert.equal(indexationReasonKey("rate_limited"), "rateLimited")
  assert.equal(indexationReasonKey("ocr_timeout"), "ocrFailed")
})

test("an unknown reason returns null so the caller can show the raw string", () => {
  // Swallowing it would hide a whole failure mode behind a blank badge.
  assert.equal(indexationReasonKey("some_future_stage_failed: detail"), null)
})
