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
 * pagination/shape-tolerance logic mirrors V1's `ClusterClient` exactly.
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
} from "../../../worker/src/cluster/dataset.js";
// Local (vendored) transport — MUST share worker-v2's undici with the FormData
// built below; see cluster-http.ts for why importing worker/'s ClusterHttp hangs.
import { ClusterHttp } from "./cluster-http.js";
import { arkSlug } from "../domain/keys.js";
import type { DocMeta, PreparedPage } from "../domain/types.js";
import type { ClusterSink } from "../ports.js";

interface DatasetView {
  id: number;
  name?: string;
  slug?: string;
}

interface EntryView {
  id: number;
  slug?: string;
}

interface CreateEntryResponse {
  entry?: EntryView;
  id?: number;
}

/** One chunk to index — the shape the cluster's /chunks endpoint expects. */
export interface IndexChunk {
  chunk_text: string;
  chunk_index: number;
  embedding: number[];
  metadata: Record<string, unknown>;
}

export interface LiveClusterSinkOptions {
  http?: ClusterHttp;
}

/**
 * Assemble a doc's pages into one markdown document, folio-headed. Pure —
 * exported for testing. Each page is prefixed with its folio so the stored
 * `original`/`processed` text stays navigable.
 */
export function assembleMarkdown(pages: PreparedPage[]): string {
  return pages.map((p) => `## Folio ${p.ordre}\n\n${p.text.trim()}`).join("\n\n");
}

/**
 * Build the per-page index chunks (one chunk per page). Pure — exported for
 * testing. Aligns each page with its embedding by position; the caller
 * guarantees `pages.length === embeddings.length`.
 */
export function buildIndexChunks(
  ark: string,
  meta: DocMeta,
  pages: PreparedPage[],
  embeddings: number[][],
): IndexChunk[] {
  return pages.map((p, i) => {
    const metadata: Record<string, unknown> = {
      ark,
      ark_slug: arkSlug(ark),
      doc_type: meta.docType ?? null,
      sub_type: meta.subtype ?? null,
      folio: p.ordre,
    };
    return {
      chunk_text: p.text,
      chunk_index: i,
      embedding: embeddings[i]!,
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
      dataset_type: "text",
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
    const existing = await this.findEntryBySlug(datasetId, slug);
    if (existing) await this.http.deleteJson(`/api/v1/entries/${existing.id}`);

    const markdown = assembleMarkdown(pages);
    const entry = await this.createEntry({
      dataset_id: datasetId,
      // The ARK is the entry's identity — short, opaque, unique, always < 255.
      // BnF titles can run past the backend's 255-char `name` validator (the
      // batch-sync 422s); the full title is preserved in metadata below.
      name: ark,
      slug,
      description: markdown.slice(0, 200),
      metadata: {
        ark,
        arkSlug: slug,
        title: meta.title,
        creator: meta.creator,
        date: meta.date,
        docType: meta.docType,
        subtype: meta.subtype,
        lang: meta.lang,
        source: "gallica",
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
      collection_name: "entry_chunks",
    });

    return { entryId: entry.id };
  }

  /**
   * Find an entry by (datasetId, slug). The cluster's list endpoint doesn't
   * honor a `slug` query param — it returns all entries — so we page and filter
   * client-side, exactly as V1's ClusterClient does (page_size=100, max 50
   * pages). Returns null when not found.
   */
  private async findEntryBySlug(datasetId: number, slug: string): Promise<EntryView | null> {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 50;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.http.getJson<{
        entries?: EntryView[];
        total_pages?: number;
      }>(`/api/v1/entries?dataset_id=${datasetId}&page=${page}&page_size=${PAGE_SIZE}`);
      const hit = (res.entries ?? []).find((e) => e.slug === slug);
      if (hit) return hit;
      const totalPages = res.total_pages ?? 1;
      if (page >= totalPages) return null;
    }
    return null;
  }

  /** Create an entry, tolerating both `{ entry: {...} }` and bare `{...}` shapes. */
  private async createEntry(input: {
    dataset_id: number;
    name: string;
    slug: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<EntryView> {
    const res = await this.http.postJson<CreateEntryResponse | EntryView>(
      "/api/v1/entries",
      input,
    );
    if (res && typeof res === "object" && "entry" in res && res.entry) {
      return res.entry;
    }
    if (
      res &&
      typeof res === "object" &&
      "id" in res &&
      typeof (res as EntryView).id === "number"
    ) {
      return res as EntryView;
    }
    throw new Error(
      `createEntry: unexpected response shape: ${JSON.stringify(res).slice(0, 200)}`,
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
