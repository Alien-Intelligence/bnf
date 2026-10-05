/**
 * Live ClusterSink — wraps V1's proven cluster transport (`ClusterHttp`) and
 * dataset helpers (`bnfDatasetSlug` / `bnfDatasetSchema`).
 *
 * V1's `BnfClusterSink.upsert` took a whole `PreparedDoc` (chunks + markdown)
 * and embedded inside the sink. V2 splits responsibilities: embedding already
 * happened (the embed stage), so the sink receives `pages` + precomputed
 * `embeddings` and just writes them. The cluster-write sequence is otherwise the
 * same proven five steps V1 ran:
 *
 *   ensureDataset → get-by-slug, else create (slug = bnf-<projectId>).
 *   upsert        → (tombstone any stale entry) → create entry → upload doc.md
 *                   (original) → save processed content → index one chunk per
 *                   page with its precomputed embedding. Per-chunk metadata
 *                   carries ark + folio (ordre) so citations survive
 *                   ([[ark|label|folio]] deep-links to IIIF).
 *
 * Transport reuse: V1's `ClusterClient` cannot be imported here — its
 * `uploadOriginalFile` builds `new Blob([Buffer])`, which V1's `Bundler`
 * tsconfig tolerates but V2's stricter `NodeNext` lib resolution rejects
 * (`Buffer` ⊄ `BlobPart`, the SharedArrayBuffer-in-union friction). Rather than
 * edit V1 (out of bounds) or `as any` the cast, we reuse the lower transport
 * (`ClusterHttp`, which typechecks cleanly under both configs) and re-express the
 * thin REST calls here with a correctly-typed `Uint8Array` multipart body. The
 * shape-tolerance logic mirrors V1's `ClusterClient`; the slug lookup does not
 * (see findEntryBySlug).
 *
 * One chunk per page is the V2 contract: pages already carry the folio `ordre`,
 * which is the citation key. The chunk metadata mirrors V1's snake_case filter
 * keys (ark, ark_slug, doc_type, sub_type, folio) so the cluster's filter
 * language keeps working.
 */
import { FormData } from "undici";

import {
  bnfDatasetSchema,
  bnfDatasetSlug,
} from "./vendor/dataset.js";
// Local (vendored) transport — MUST share worker-v2's undici with the FormData
// built below; see cluster-http.ts for why importing worker/'s ClusterHttp hangs.
import { ClusterHttp } from "./cluster-http.js";
import { arkSlug } from "../domain/keys.js";
import type { DocMeta, PreparedPage } from "../domain/types.js";
import type { ClusterSink } from "../ports.js";

/** The dataset type of a BnF corpus dataset. */
const DATASET_TYPE_TEXT = "text";
/** Where every entry this sink writes comes from. */
const ENTRY_SOURCE_GALLICA = "gallica";
/** The cluster's vector collection for page chunks. */
const CHUNK_COLLECTION = "entry_chunks";
/** Code points of the markdown kept as the entry's description. */
const ENTRY_DESCRIPTION_CHARS = 200;
/** Characters of an unexpected response quoted in an error. */
const ERROR_EXCERPT_CHARS = 200;
/**
 * Entries per page when walking a dataset for a slug: the list endpoint's
 * maximum (`limit`, 1..100; outside that it silently falls back to 20).
 */
const ENTRY_LIST_PAGE_SIZE = 100;

interface DatasetView {
  id: number;
  name?: string;
  slug?: string;
}

export interface EntryView {
  id: number;
  slug?: string;
}

/**
 * Metadata written on every page chunk. The app reads it back through the
 * data-cluster MCP (`lib/cluster/rag-wire.ts` chunkToPassage).
 *
 * `char_start` / `char_end` are the page text's range inside the entry's
 * processed markdown, in UNICODE CODE POINTS: the consumer slices a Python
 * `str` (mcp-datacluster get_entry_content.py), so a JS UTF-16 length would
 * drift by one per astral-plane character. The app pins the same literal
 * sample in lib/cluster/folio-text.test.ts.
 */
export interface IndexChunkMetadata {
  ark: string;
  ark_slug: string;
  doc_type: string | null;
  sub_type: string | null;
  folio: number;
  char_start: number;
  char_end: number;
}

/** One chunk to index — the shape the cluster's /chunks endpoint expects. */
export interface IndexChunk {
  chunk_text: string;
  chunk_index: number;
  embedding: number[];
  metadata: IndexChunkMetadata;
}

export interface LiveClusterSinkOptions {
  http?: ClusterHttp;
}

/** Heading that opens each page block in the assembled markdown. */
function folioHeading(ordre: number): string {
  return `## Folio ${ordre}\n\n`;
}

/** Separator between two page blocks in the assembled markdown. */
const FOLIO_BLOCK_SEPARATOR = "\n\n";

/**
 * Length in Unicode code points — the unit of `char_start` / `char_end` (see
 * IndexChunkMetadata). A surrogate pair is one code point; a lone surrogate
 * counts as one, as in a Python `str`.
 */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++, n++) {
    const unit = s.charCodeAt(i);
    if (unit >= HIGH_SURROGATE_MIN && unit <= HIGH_SURROGATE_MAX && i + 1 < s.length) {
      const nextUnit = s.charCodeAt(i + 1);
      if (nextUnit >= LOW_SURROGATE_MIN && nextUnit <= LOW_SURROGATE_MAX) i++;
    }
  }
  return n;
}

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

/** The first `n` code points of `s` — never half a surrogate pair. */
function headCodePoints(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

/**
 * Assemble a doc's pages into one markdown document, folio-headed. Pure —
 * exported for testing. Each page is prefixed with its folio so the stored
 * `original`/`processed` text stays navigable.
 *
 * Format consumed by the app's `lib/cluster/folio-text.ts` (splitEntryFolios,
 * which the quote check relies on) — change both together, and keep the
 * contract tests on both sides (`cluster.test.ts`, `folio-text.test.ts`) on the
 * same literal sample.
 */
export function assembleMarkdown(pages: PreparedPage[]): string {
  return pages
    .map((p) => `${folioHeading(p.ordre)}${pageBody(p.text)}`)
    .join(FOLIO_BLOCK_SEPARATOR);
}

/**
 * A line of page text that starts like a folio heading — `## Folio <digits>`,
 * after any number of backslashes — gets one more leading backslash, so no
 * page text can ever read as a boundary the worker wrote (a Mistral-lane page
 * can contain a Markdown `## Folio 40`). Reversible: the app's splitter
 * (lib/cluster/folio-text.ts unescapeFolioHeadings) removes exactly one.
 */
export function escapeFolioHeadings(text: string): string {
  return text.replace(/^(\\*)## Folio (\d)/gm, "\\$1## Folio $2");
}

/** A page's stored text: trimmed, then heading-shaped lines escaped. */
function pageBody(text: string): string {
  return escapeFolioHeadings(text.trim());
}

/**
 * Build the per-page index chunks (one chunk per page). Pure — exported for
 * testing. Aligns each page with its embedding by position, and throws when
 * `pages.length !== embeddings.length` (a misalignment would corrupt citations).
 *
 * `char_start` / `char_end` are the page body's offsets inside
 * `assembleMarkdown(pages)` in Unicode code points, computed with the same
 * heading and separator, so a code-point slice of the markdown (Python's
 * `markdown[char_start:char_end]`) equals `chunk_text` for every chunk.
 * The chunk text is therefore the page text exactly as the markdown holds it:
 * trimmed, with heading-shaped lines escaped (escapeFolioHeadings).
 * The app surfaces the pair as `RagPassage.charRange` for `rag_get_text`.
 */
export function buildIndexChunks(
  ark: string,
  meta: DocMeta,
  pages: PreparedPage[],
  embeddings: number[][],
): IndexChunk[] {
  if (pages.length !== embeddings.length) {
    // A page/vector misalignment would corrupt citations — fail loudly.
    throw new Error(
      `buildIndexChunks: ${pages.length} pages but ${embeddings.length} embeddings for ${ark}`,
    );
  }
  let offset = 0;
  return pages.map((p, i) => {
    const embedding = embeddings[i];
    if (embedding === undefined) throw new Error(`buildIndexChunks: no embedding for page ${i} of ${ark}`);
    const text = pageBody(p.text);
    const charStart = offset + codePointLength(folioHeading(p.ordre));
    const charEnd = charStart + codePointLength(text);
    offset = charEnd + codePointLength(FOLIO_BLOCK_SEPARATOR);
    const metadata: IndexChunkMetadata = {
      ark,
      ark_slug: arkSlug(ark),
      doc_type: meta.docType ?? null,
      sub_type: meta.subtype ?? null,
      folio: p.ordre,
      char_start: charStart,
      char_end: charEnd,
    };
    return {
      chunk_text: text,
      chunk_index: i,
      embedding,
      metadata,
    };
  });
}

export class LiveClusterSink implements ClusterSink {
  private readonly http: ClusterHttp;

  constructor(opts: LiveClusterSinkOptions = {}) {
    this.http = opts.http ?? new ClusterHttp();
  }

  async ensureDataset(input: { projectId: string }): Promise<{ datasetId: number }> {
    const slug = bnfDatasetSlug(input.projectId);
    const existing = await this.http.getJsonOrNull<DatasetView>(
      `/api/v1/datasets/slug/${encodeURIComponent(slug)}`,
    );
    if (existing) return { datasetId: existing.id };
    const created = await this.http.postJson<DatasetView>("/api/v1/datasets", {
      name: `BnF ${input.projectId}`,
      slug,
      description: `BnF corpus dataset for project ${input.projectId}`,
      dataset_type: DATASET_TYPE_TEXT,
      schema_definition: bnfDatasetSchema(input.projectId),
    });
    return { datasetId: created.id };
  }

  async upsert(input: {
    datasetId: number;
    ark: string;
    meta: DocMeta;
    pages: PreparedPage[];
    embeddings: number[][];
  }): Promise<{ entryId: number }> {
    const { datasetId, ark, meta, pages, embeddings } = input;
    if (pages.length !== embeddings.length) {
      // A page/vector misalignment would corrupt citations — fail loudly.
      throw new Error(
        `cluster upsert: ${pages.length} pages but ${embeddings.length} embeddings for ${ark}`,
      );
    }

    const slug = arkSlug(ark);
    // Idempotent re-ingest: tombstone a stale entry so a fresh insert lands
    // cleanly (the cluster DELETE cascades through MinIO + Qdrant + Meilisearch).
    const existing = await findEntryBySlug((path) => this.http.getJson<unknown>(path), datasetId, slug);
    if (existing) await this.http.deleteJson(`/api/v1/entries/${existing.id}`);

    const markdown = assembleMarkdown(pages);
    const entry = await this.createEntry({
      dataset_id: datasetId,
      // The ARK is the entry's identity — short, opaque, unique, always < 255.
      // BnF titles can run past the backend's 255-char `name` validator (the
      // batch-sync 422s); the full title is preserved in metadata below.
      name: ark,
      slug,
      description: headCodePoints(markdown, ENTRY_DESCRIPTION_CHARS),
      metadata: {
        ark,
        arkSlug: slug,
        title: meta.title,
        creator: meta.creator,
        date: meta.date,
        docType: meta.docType,
        subtype: meta.subtype,
        lang: meta.lang,
        source: ENTRY_SOURCE_GALLICA,
        pageCount: meta.pageCount,
        ocrAvailable: meta.ocrAvailable,
      },
    });

    await this.uploadOriginalFile(entry.id, "doc.md", Buffer.from(markdown, "utf8"));
    await this.http.postJson(`/api/v1/entries/${entry.id}/processed`, {
      content: { text: markdown },
    });
    await this.http.postJson(`/api/v1/entries/${entry.id}/chunks`, {
      chunks: buildIndexChunks(ark, meta, pages, embeddings),
      collection_name: CHUNK_COLLECTION,
    });

    return { entryId: entry.id };
  }

  /** Create an entry, accepting both `{ entry: {...} }` and bare `{...}` shapes. */
  private async createEntry(input: {
    dataset_id: number;
    name: string;
    slug: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<EntryView> {
    const res = await this.http.postJson<unknown>("/api/v1/entries", input);
    const entry = isRecord(res) && "entry" in res ? res.entry : res;
    if (isEntryView(entry)) return entry;
    throw new Error(
      `createEntry: unexpected response shape: ${JSON.stringify(res).slice(0, ERROR_EXCERPT_CHARS)}`,
    );
  }

  /**
   * Multipart upload of the doc's `original` file. The body is rebuilt per
   * attempt (undici FormData / its stream is single-use), and the bytes are
   * wrapped in a `Uint8Array` — a valid `BlobPart` under NodeNext (a raw Buffer
   * is not, the SharedArrayBuffer-in-union friction).
   */
  private async uploadOriginalFile(
    entryId: number,
    filename: string,
    bytes: Buffer,
  ): Promise<void> {
    const formFactory = (): FormData => {
      const form = new FormData();
      const blob = new Blob([new Uint8Array(bytes)], {
        type: "application/octet-stream",
      });
      form.set("file", blob, filename);
      form.set("file_type", "original");
      return form;
    };
    await this.http.postForm(`/api/v1/entries/${entryId}/upload`, formFactory);
  }
}

// ---------------------------------------------------------------------------
// Response parsing (the cluster's JSON is checked, never cast)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEntryView(value: unknown): value is EntryView {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    (value.slug === undefined || typeof value.slug === "string")
  );
}

/** The URL of one page of a dataset's entries (`page` is 1-based; the endpoint takes `limit`, not `page_size`). */
export function entryListPageUrl(datasetId: number, page: number): string {
  return `/api/v1/entries?dataset_id=${datasetId}&page=${page}&limit=${ENTRY_LIST_PAGE_SIZE}`;
}

/**
 * Find an entry of a dataset by slug, or null when the dataset has none.
 *
 * The cluster has no lookup by slug over HTTP (its entries list takes no
 * `slug` filter; `get_by_slug` exists only inside the create route), so this
 * walks the list until its last page — every page, no cap: answering null
 * for a slug past a cap would make upsert create a SECOND entry for the ARK.
 *
 * The list is ordered by `created_at DESC` with no tie-breaker, and the
 * client cannot ask for another order. So one walk can miss an entry that is
 * there: an entry deleted during the walk shifts later pages up by one, and
 * entries with equal timestamps may swap across a page boundary. A miss is
 * therefore confirmed by a second full walk before it is believed. (The
 * create route's own 409 on a duplicate slug is the last line behind it.) A
 * server-side lookup is the real fix — see the ticket text in the Track C
 * implementation log.
 */
export async function findEntryBySlug(
  getPage: (path: string) => Promise<unknown>,
  datasetId: number,
  slug: string,
): Promise<EntryView | null> {
  const walk = async (): Promise<EntryView | null> => {
    for (let page = 1; ; page++) {
      const res = parseEntryListPage(await getPage(entryListPageUrl(datasetId, page)));
      const hit = res.entries.find((e) => e.slug === slug);
      if (hit) return hit;
      // total_pages is re-read on every page: the list may grow during the walk.
      if (page >= res.totalPages || res.entries.length === 0) return null;
    }
  };
  return (await walk()) ?? (await walk());
}

/** One page of `GET /api/v1/entries`: its entries and the page count, both required. */
export function parseEntryListPage(value: unknown): { entries: EntryView[]; totalPages: number } {
  if (!isRecord(value) || !Array.isArray(value.entries) || !value.entries.every(isEntryView)) {
    throw new Error(
      `entry list: expected { entries: [{ id, slug }] }, got ${JSON.stringify(value).slice(0, ERROR_EXCERPT_CHARS)}`,
    );
  }
  const totalPages = value.total_pages;
  if (typeof totalPages !== "number" || !Number.isSafeInteger(totalPages) || totalPages < 0) {
    throw new Error(`entry list: missing or invalid total_pages ${JSON.stringify(totalPages)}`);
  }
  return { entries: value.entries, totalPages };
}
