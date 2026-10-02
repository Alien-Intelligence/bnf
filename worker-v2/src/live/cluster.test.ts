/**
 * Pure-logic tests for the live ClusterSink helpers + the dataset slug.
 *
 * Citation-critical: every indexed chunk must carry ark + folio (ordre), and the
 * embedding must align with its page by position. No network — just the pure
 * builders and the dataset slug derivation (reused verbatim from V1).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { bnfDatasetSlug } from "./vendor/dataset.js";
import type { DocMeta, PreparedPage } from "../domain/types.js";
import { assembleMarkdown, buildIndexChunks, codePointLength } from "./cluster.js";

const meta: DocMeta = {
  title: "Plan de Paris",
  creator: "Anon.",
  date: "1830",
  docType: "carte",
  subtype: null,
  lang: "fre",
  pageCount: 2,
  ocrAvailable: false,
};

const pages: PreparedPage[] = [
  { ordre: 5, text: "Texte folio 5" },
  { ordre: 9, text: "Texte folio 9" },
];

test("bnfDatasetSlug derives bnf-<projectId>", () => {
  assert.equal(bnfDatasetSlug("abc123"), "bnf-abc123");
});

test("assembleMarkdown headers each page with its folio", () => {
  const md = assembleMarkdown(pages);
  assert.equal(md, "## Folio 5\n\nTexte folio 5\n\n## Folio 9\n\nTexte folio 9");
});

test("buildIndexChunks aligns embeddings by position and carries ark + folio", () => {
  const embeddings = [
    [0.1, 0.2],
    [0.3, 0.4],
  ];
  const chunks = buildIndexChunks("ark:/12148/btv1b8600001", meta, pages, embeddings);
  assert.equal(chunks.length, 2);

  assert.equal(chunks[0]!.chunk_text, "Texte folio 5");
  assert.equal(chunks[0]!.chunk_index, 0);
  assert.deepEqual(chunks[0]!.embedding, [0.1, 0.2]);
  assert.equal(chunks[0]!.metadata.ark, "ark:/12148/btv1b8600001");
  assert.equal(chunks[0]!.metadata.ark_slug, "btv1b8600001");
  assert.equal(chunks[0]!.metadata.folio, 5);
  assert.equal(chunks[0]!.metadata.doc_type, "carte");

  // Second page → second embedding → folio 9.
  assert.deepEqual(chunks[1]!.embedding, [0.3, 0.4]);
  assert.equal(chunks[1]!.metadata.folio, 9);
});

// --- CONTRACT (keep identical to lib/cluster/folio-text.test.ts) ----------
// The app splits this markdown and slices it with these offsets; the consumer
// of the offsets slices a Python `str`, so they are Unicode code points. The
// sample carries an astral-plane character and a whitespace-only page.
const CONTRACT_PAGES: PreparedPage[] = [
  { ordre: 5, text: "Texte folio 5" },
  { ordre: 9, text: "  Le 𝔊 gothique — Œuvre\nsur deux lignes \n" },
  { ordre: 10, text: "   " },
  { ordre: 12, text: "Dernier 😀 mot" },
];
const CONTRACT_MARKDOWN =
  "## Folio 5\n\nTexte folio 5\n\n## Folio 9\n\nLe 𝔊 gothique — Œuvre\nsur deux lignes" +
  "\n\n## Folio 10\n\n\n\n## Folio 12\n\nDernier 😀 mot";
/** `[char_start, char_end]` per page, in Unicode code points (Python `str` indices). */
const CONTRACT_OFFSETS: Array<[number, number]> = [
  [12, 25],
  [39, 76],
  [91, 91],
  [106, 119],
];
// ---------------------------------------------------------------------------

test("CONTRACT: assembleMarkdown writes the literal sample", () => {
  assert.equal(assembleMarkdown(CONTRACT_PAGES), CONTRACT_MARKDOWN);
  assert.equal(codePointLength(CONTRACT_MARKDOWN), 119);
  assert.equal(CONTRACT_MARKDOWN.length, 121, "two astral characters: UTF-16 length differs");
});

test("CONTRACT: char_start/char_end are the literal code-point offsets of each trimmed page", () => {
  const embeddings = CONTRACT_PAGES.map((_, i) => [i / 10]);
  const chunks = buildIndexChunks("ark:/12148/btv1b8600001", meta, CONTRACT_PAGES, embeddings);
  assert.equal(chunks.length, CONTRACT_PAGES.length);
  assert.deepEqual(
    chunks.map((c) => [c.metadata.char_start, c.metadata.char_end]),
    CONTRACT_OFFSETS,
  );
  const codePoints = Array.from(CONTRACT_MARKDOWN);
  for (const [i, chunk] of chunks.entries()) {
    const page = CONTRACT_PAGES[i];
    assert.ok(page, `page ${i} exists`);
    assert.equal(chunk.chunk_text, page.text.trim(), `chunk ${i} text is trimmed`);
    assert.equal(
      codePoints.slice(chunk.metadata.char_start, chunk.metadata.char_end).join(""),
      chunk.chunk_text,
      `chunk ${i} offsets slice the markdown (by code point) to its text`,
    );
  }
});

test("buildIndexChunks refuses a page/embedding count mismatch", () => {
  assert.throws(
    () => buildIndexChunks("ark:/12148/btv1b8600001", meta, CONTRACT_PAGES, [[0.1]]),
    /4 pages but 1 embeddings/,
  );
});
