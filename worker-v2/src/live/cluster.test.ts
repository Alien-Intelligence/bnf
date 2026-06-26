/**
 * Pure-logic tests for the live ClusterSink helpers + the dataset slug.
 *
 * Citation-critical: every indexed chunk must carry ark + folio (ordre), and the
 * embedding must align with its page by position. No network — just the pure
 * builders and the dataset slug derivation (reused verbatim from V1).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { bnfDatasetSlug } from "../../../worker/src/cluster/dataset.js";
import type { DocMeta, PreparedPage } from "../domain/types.js";
import { assembleMarkdown, buildIndexChunks } from "./cluster.js";

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
