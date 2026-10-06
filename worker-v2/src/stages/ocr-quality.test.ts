/**
 * The artifact validator follows OCR_QUALITY_ARTIFACT_VERSION (pass-6 item 5):
 * after a bump, an artifact of the previous version must read as invalid (the
 * sync endpoint then rebuilds it) and one of the new version as valid. A
 * hard-coded version in the check would pass every test written at the
 * current version, so the version is a parameter and is tested at two values.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { OCR_QUALITY_ARTIFACT_VERSION } from "../domain/types.js";
import { isDocOcrQuality, isDocOcrQualityAt } from "./ocr-quality.js";

const ARK = "ark:/12148/bpt6k841545p";
const artifact = (v: number) => ({
  v,
  ark: ARK,
  ocrRate: 0.9,
  lane: "text",
  folios: [{ ordre: 1, ocrSource: "alto", ocrQuality: 0.9, wordCount: 10 }],
  builtAt: "2026-10-01T13:49:53.149Z",
});

test("the current version's artifact is valid; the next version's is not", () => {
  assert.equal(isDocOcrQuality(artifact(OCR_QUALITY_ARTIFACT_VERSION), ARK), true);
  assert.equal(isDocOcrQuality(artifact(OCR_QUALITY_ARTIFACT_VERSION + 1), ARK), false);
});

test("after a bump the check follows the version: the new one valid, the previous one not", () => {
  const next = OCR_QUALITY_ARTIFACT_VERSION + 1;
  assert.equal(isDocOcrQualityAt(next, artifact(next), ARK), true);
  assert.equal(isDocOcrQualityAt(next, artifact(OCR_QUALITY_ARTIFACT_VERSION), ARK), false);
});
