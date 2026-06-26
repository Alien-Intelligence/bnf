/**
 * classifyLane / isImageDocType — pure routing decision unit tests.
 *
 * The lane decision is the metadata stage's branch point (text / vision / mistral
 * / skip), lifted verbatim from V1. These tests pin the four branches plus the
 * ocrAvailable-precedence rule and the isImageDocType substring matcher.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyLane, isImageDocType } from "./classify.js";

test("ocrAvailable text doc → text lane", () => {
  const d = classifyLane({ ocrAvailable: true, docType: "texte" }, { mistralEnabled: false });
  assert.deepEqual(d, { kind: "lane", lane: "text" });
});

test("no OCR + visual docType → vision lane (a few image substrings)", () => {
  for (const docType of ["estampe", "carte ancienne", "image fixe"]) {
    const d = classifyLane({ ocrAvailable: false, docType }, { mistralEnabled: false });
    assert.deepEqual(d, { kind: "lane", lane: "vision" }, `docType=${docType}`);
  }
});

test("no OCR + text docType + mistral enabled → mistral lane", () => {
  const d = classifyLane({ ocrAvailable: false, docType: "texte" }, { mistralEnabled: true });
  assert.deepEqual(d, { kind: "lane", lane: "mistral" });
});

test("no OCR + text docType + mistral disabled → skip", () => {
  const d = classifyLane({ ocrAvailable: false, docType: "texte" }, { mistralEnabled: false });
  assert.deepEqual(d, { kind: "skip", reason: "no_ocr_and_not_single_image" });
});

test("ocrAvailable wins even when docType looks like an image", () => {
  const d = classifyLane({ ocrAvailable: true, docType: "estampe" }, { mistralEnabled: true });
  assert.deepEqual(d, { kind: "lane", lane: "text" }, "OCR text layer takes precedence over visual docType");
});

test("isImageDocType(null) is false", () => {
  assert.equal(isImageDocType(null), false);
});

test("isImageDocType matches known visual substrings case-insensitively", () => {
  assert.equal(isImageDocType("ESTAMPE"), true);
  assert.equal(isImageDocType("Carte ancienne"), true);
  assert.equal(isImageDocType("image fixe"), true);
  assert.equal(isImageDocType("texte"), false);
});
