/**
 * isAltoFolioQuality — the only guard on both read paths of the ALTO
 * word-confidence sidecar (ensureAltoFolio and the artifact build). It must
 * enforce the D1 invariants, not just the field types: a sidecar claiming a
 * mean WC of 93.2 used to pass and read as "not low".
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isAltoFolioQuality } from "./alto-folio.js";

const OK = { v: 1, wordCount: 10, scoredWordCount: 8, meanWc: 0.66 };

test("a well-formed sidecar passes, including the empty folio and an ALTO without WC", () => {
  assert.equal(isAltoFolioQuality(OK), true);
  assert.equal(isAltoFolioQuality({ v: 1, wordCount: 0, scoredWordCount: 0, meanWc: null }), true);
  assert.equal(isAltoFolioQuality({ v: 1, wordCount: 5, scoredWordCount: 0, meanWc: null }), true);
});

test("meanWc must be a finite number in [0, 1]", () => {
  for (const meanWc of [93.2, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isAltoFolioQuality({ ...OK, meanWc }), false, String(meanWc));
  }
});

test("counts must be non-negative integers with scoredWordCount <= wordCount", () => {
  assert.equal(isAltoFolioQuality({ ...OK, wordCount: -1 }), false);
  assert.equal(isAltoFolioQuality({ ...OK, wordCount: 2.5 }), false);
  assert.equal(isAltoFolioQuality({ ...OK, scoredWordCount: 11 }), false);
});

test("meanWc is null exactly when no word is scored", () => {
  assert.equal(isAltoFolioQuality({ ...OK, meanWc: null }), false, "scored words but no mean");
  assert.equal(isAltoFolioQuality({ ...OK, scoredWordCount: 0 }), false, "a mean over zero words");
});

test("anything else is not a sidecar", () => {
  assert.equal(isAltoFolioQuality(null), false);
  assert.equal(isAltoFolioQuality({ ...OK, v: 2 }), false);
  assert.equal(isAltoFolioQuality([OK]), false);
});
