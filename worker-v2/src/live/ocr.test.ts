/**
 * Pure-logic tests for the live OCR result parsing.
 *
 * These are the citation-critical bits: the custom_id↔ordre alignment (results
 * may arrive in any order — must realign by custom_id, never positionally), the
 * empty/blank drop, and the hallucinated-page drop. No SDK, no network — we feed
 * a fake Mistral batch-output JSONL through parseOcrOutput and assert the pages.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildBatchJsonl, looksLikeHallucinatedOcr, parseOcrOutput } from "./ocr.js";

function line(customId: string, markdown: string): string {
  return JSON.stringify({
    custom_id: customId,
    response: { status_code: 200, body: { pages: [{ index: 0, markdown }] } },
  });
}

test("parseOcrOutput realigns by custom_id and sorts by ordre (not positional)", () => {
  // Deliberately out of order: f3 then f1 then f2.
  const jsonl = [
    line("f3", "Texte du folio 3"),
    line("f1", "Texte du folio 1"),
    line("f2", "Texte du folio 2"),
  ].join("\n");
  const pages = parseOcrOutput(jsonl);
  assert.deepEqual(pages, [
    { ordre: 1, text: "Texte du folio 1" },
    { ordre: 2, text: "Texte du folio 2" },
    { ordre: 3, text: "Texte du folio 3" },
  ]);
});

test("parseOcrOutput drops empty/whitespace markdown (legitimately blank folio)", () => {
  const jsonl = [line("f1", "Réel"), line("f2", "   "), line("f3", "")].join("\n");
  const pages = parseOcrOutput(jsonl);
  assert.deepEqual(pages, [{ ordre: 1, text: "Réel" }]);
});

test("parseOcrOutput skips malformed lines and bad custom_ids", () => {
  const jsonl = [
    line("f1", "ok"),
    "not json at all",
    JSON.stringify({ custom_id: "garbage", response: { body: { pages: [{ markdown: "x" }] } } }),
    "",
  ].join("\n");
  const pages = parseOcrOutput(jsonl);
  assert.deepEqual(pages, [{ ordre: 1, text: "ok" }]);
});

test("parseOcrOutput drops a hallucinated page (repeated filler line)", () => {
  const repeated = Array.from({ length: 6 }, () => "This is a repeated filler line.").join("\n");
  const jsonl = [line("f1", "Vrai texte de la page"), line("f2", repeated)].join("\n");
  const pages = parseOcrOutput(jsonl);
  assert.deepEqual(pages, [{ ordre: 1, text: "Vrai texte de la page" }]);
});

test("looksLikeHallucinatedOcr: repeated long line ≥4× is flagged", () => {
  const md = Array.from({ length: 5 }, () => "Une longue ligne répétée encore.").join("\n");
  assert.equal(looksLikeHallucinatedOcr(md), true);
});

test("looksLikeHallucinatedOcr: filler markers ≥2 are flagged", () => {
  const md = ["cannot be extracted from here", "this is a simple diagram of nothing"].join("\n");
  assert.equal(looksLikeHallucinatedOcr(md), true);
});

test("looksLikeHallucinatedOcr: genuine prose is not flagged", () => {
  const md = [
    "Le manuscrit décrit les fortifications de la ville.",
    "Une carte détaillée accompagne le texte principal.",
    "Les annotations marginales sont nombreuses et précises.",
  ].join("\n");
  assert.equal(looksLikeHallucinatedOcr(md), false);
});

test("buildBatchJsonl: one valid JSONL line per folio, custom_id carries ordre", () => {
  const folios = [
    { ordre: 1, image: Buffer.from("img-one") },
    { ordre: 7, image: Buffer.from("img-seven") },
  ];
  const out = buildBatchJsonl("ark:/12148/btv1b000", folios);
  const lines = out.toString("utf8").trimEnd().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]!);
  assert.equal(first.custom_id, "f1");
  assert.equal(
    first.body.document.image_url,
    `data:image/jpeg;base64,${Buffer.from("img-one").toString("base64")}`,
  );
  assert.equal(JSON.parse(lines[1]!).custom_id, "f7");
});

test("buildBatchJsonl: empty folio list yields an empty buffer", () => {
  assert.equal(buildBatchJsonl("ark:/12148/x", []).length, 0);
});

test("buildBatchJsonl: oversized batch throws an attributable error (no V8 crash)", () => {
  // A single ~6MB image; 300 of them (~1.8GB base64) exceeds the safe ceiling.
  const big = Buffer.alloc(6 * 1024 * 1024, 0x41);
  const folios = Array.from({ length: 300 }, (_, i) => ({ ordre: i + 1, image: big }));
  assert.throws(
    () => buildBatchJsonl("ark:/12148/huge", folios),
    /ark:\/12148\/huge batch input exceeds .* bytes/,
  );
});
