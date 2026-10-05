/**
 * isAltoFolioQuality — the only guard on both read paths of the ALTO
 * word-confidence sidecar (ensureAltoFolio and the artifact build). It must
 * enforce the D1 invariants, not just the field types: a sidecar claiming a
 * mean WC of 93.2 used to pass and read as "not low".
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryBlobStore } from "../core/blob.js";
import { createMemoryLogger } from "../core/logger.js";
import { keys } from "../domain/keys.js";
import { FakeBnfClient } from "../testing/fakes.js";
import { ensureAltoFolio, isAltoFolioQuality } from "./alto-folio.js";

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

test("ensureAltoFolio: an answer arriving after the ceiling is discarded — no text, no sidecar written", async () => {
  const ark = "ark:/12148/bpt6k4625753w";
  const blob = new MemoryBlobStore();
  const { logger } = createMemoryLogger();
  const ceiling = new AbortController();
  // A BnF client whose fetch completes only after the delivery's ceiling.
  class LateAnswer extends FakeBnfClient {
    override async fetchAltoFolio(a: string, o: number) {
      const folio = await super.fetchAltoFolio(a, o);
      ceiling.abort(new Error("ceiling"));
      return folio;
    }
  }
  const slow = new LateAnswer().add({ ark, ocrAvailable: true, docType: "texte", pageCount: 1 });
  await assert.rejects(
    ensureAltoFolio({ bnf: slow, blob, log: logger, signal: ceiling.signal }, ark, 1),
    /ceiling/,
  );
  assert.equal(await blob.getBytes(keys.alto(ark, 1)), null, "no text written");
  assert.equal(await blob.getJson(keys.altoQuality(ark, 1)), null, "no sidecar written");
});

test("ensureAltoFolio: an already-aborted signal makes no BnF call", async () => {
  const ark = "ark:/12148/bpt6k4625753w";
  const fake = new FakeBnfClient().add({ ark, ocrAvailable: true, docType: "texte", pageCount: 1 });
  const { logger } = createMemoryLogger();
  await assert.rejects(
    ensureAltoFolio({ bnf: fake, blob: new MemoryBlobStore(), log: logger, signal: AbortSignal.abort() }, ark, 1),
  );
  assert.equal(fake.calls.alto, 0);
});
