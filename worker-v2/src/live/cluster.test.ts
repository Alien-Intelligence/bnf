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
import {
  assembleMarkdown,
  buildIndexChunks,
  codePointLength,
  entryListPageUrl,
  escapeFolioHeadings,
  findEntryBySlug,
  parseEntryListPage,
} from "./cluster.js";

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
  const [first, second, ...rest] = buildIndexChunks("ark:/12148/btv1b8600001", meta, pages, embeddings);
  assert.ok(first && second, "one chunk per page");
  assert.equal(rest.length, 0);

  assert.equal(first.chunk_text, "Texte folio 5");
  assert.equal(first.chunk_index, 0);
  assert.deepEqual(first.embedding, [0.1, 0.2]);
  assert.equal(first.metadata.ark, "ark:/12148/btv1b8600001");
  assert.equal(first.metadata.ark_slug, "btv1b8600001");
  assert.equal(first.metadata.folio, 5);
  assert.equal(first.metadata.doc_type, "carte");

  // Second page → second embedding → folio 9.
  assert.deepEqual(second.embedding, [0.3, 0.4]);
  assert.equal(second.metadata.folio, 9);
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
  // Page text holding heading-shaped lines (one already backslashed): the
  // worker escapes them, so they can never read as a boundary.
  { ordre: 14, text: "Rubrique\n\n## Folio 40\n\nsuite\n\\## Folio 2" },
];
const CONTRACT_MARKDOWN =
  "## Folio 5\n\nTexte folio 5\n\n## Folio 9\n\nLe 𝔊 gothique — Œuvre\nsur deux lignes" +
  "\n\n## Folio 10\n\n\n\n## Folio 12\n\nDernier 😀 mot" +
  "\n\n## Folio 14\n\nRubrique\n\n\\## Folio 40\n\nsuite\n\\\\## Folio 2";
/** `[char_start, char_end]` per page, in Unicode code points (Python `str` indices). */
const CONTRACT_OFFSETS: Array<[number, number]> = [
  [12, 25],
  [39, 76],
  [91, 91],
  [106, 119],
  [134, 176],
];
// ---------------------------------------------------------------------------

test("CONTRACT: assembleMarkdown writes the literal sample", () => {
  assert.equal(assembleMarkdown(CONTRACT_PAGES), CONTRACT_MARKDOWN);
  assert.equal(codePointLength(CONTRACT_MARKDOWN), 176);
  assert.equal(CONTRACT_MARKDOWN.length, 178, "two astral characters: UTF-16 length differs");
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
    assert.equal(chunk.chunk_text, escapeFolioHeadings(page.text.trim()), `chunk ${i} text is trimmed and escaped`);
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
    /5 pages but 1 embeddings/,
  );
});

test("codePointLength counts a surrogate pair once and a lone surrogate once (as Python)", () => {
  assert.equal(codePointLength("a😀b"), 3);
  assert.equal(codePointLength("\ud83d"), 1);
  assert.equal(codePointLength("\udc00x"), 2);
});

test("parseEntryListPage requires the entries and total_pages the cluster always sends", () => {
  assert.deepEqual(parseEntryListPage({ entries: [{ id: 3, slug: "x" }], total_pages: 2 }), {
    entries: [{ id: 3, slug: "x" }],
    totalPages: 2,
  });
  assert.throws(() => parseEntryListPage({ entries: [{ id: 3 }] }), /total_pages/);
  assert.throws(() => parseEntryListPage({ total_pages: 1 }), /entries/);
  assert.throws(() => parseEntryListPage({ entries: [{ id: "3" }], total_pages: 1 }), /entries/);
});

test("escapeFolioHeadings adds exactly one backslash to heading-shaped lines", () => {
  assert.equal(escapeFolioHeadings("a\n## Folio 4\nb"), "a\n\\## Folio 4\nb");
  assert.equal(escapeFolioHeadings("\\## Folio 4"), "\\\\## Folio 4");
  assert.equal(escapeFolioHeadings("## Folio x\n### Folio 4\ntexte ## Folio 4"), "## Folio x\n### Folio 4\ntexte ## Folio 4");
});

test("entryListPageUrl asks the entries endpoint for `limit`, its page-size parameter", () => {
  assert.equal(entryListPageUrl(7, 3), "/api/v1/entries?dataset_id=7&page=3&limit=100");
});

/** A dataset of `count` entries `e0..e<count-1>`, served 100 per page; records each page asked. */
function pagedDataset(count: number, slugAt: (i: number, walk: number) => string = (i) => `e${i}`) {
  const asked: number[] = [];
  let walk = 0;
  const totalPages = Math.ceil(count / 100);
  const getPage = async (path: string): Promise<unknown> => {
    const page = Number(new URL(path, "http://cluster.invalid").searchParams.get("page"));
    if (page === 1) walk++;
    asked.push(page);
    const ids = Array.from({ length: 100 }, (_, k) => (page - 1) * 100 + k).filter((i) => i < count);
    return { entries: ids.map((i) => ({ id: i + 1, slug: slugAt(i, walk) })), total_pages: totalPages };
  };
  return { asked, getPage };
}

test("findEntryBySlug walks past the old 50-page cap to the last page", async () => {
  const ds = pagedDataset(12_000);
  assert.deepEqual(await findEntryBySlug(ds.getPage, 7, "e11999"), { id: 12_000, slug: "e11999" });
  assert.equal(ds.asked.length, 120);
});

test("findEntryBySlug confirms a miss with a second full walk, then answers null", async () => {
  const ds = pagedDataset(250);
  assert.equal(await findEntryBySlug(ds.getPage, 7, "absent"), null);
  assert.deepEqual(ds.asked, [1, 2, 3, 1, 2, 3]);
});

test("findEntryBySlug finds on the re-walk an entry the first walk missed (pages shifted under it)", async () => {
  // The entry is at a page boundary that the first walk skipped over.
  const ds = pagedDataset(250, (i, walk) => (i === 100 && walk === 2 ? "wanted" : `e${i}`));
  assert.deepEqual(await findEntryBySlug(ds.getPage, 7, "wanted"), { id: 101, slug: "wanted" });
});

test("findEntryBySlug stops on an empty page even when total_pages says more", async () => {
  const asked: number[] = [];
  const getPage = async (path: string): Promise<unknown> => {
    asked.push(Number(new URL(path, "http://cluster.invalid").searchParams.get("page")));
    return { entries: [], total_pages: 1_000_000 };
  };
  assert.equal(await findEntryBySlug(getPage, 7, "x"), null);
  assert.deepEqual(asked, [1, 1]);
});
