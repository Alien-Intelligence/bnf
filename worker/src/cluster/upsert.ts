/**
 * Composes the full Track 3 upsert flow:
 *   1. embed chunks (RunPod bge-m3)
 *   2. create entry
 *   3. upload doc.md as the `original` file
 *   4. save processed content (`{ content: { text } }`)
 *   5. index chunks with our pre-computed embeddings
 *
 * Implements the `ClusterSink` contract from src/types.ts.
 */
import type { BlobStore } from "../blob/interface.js";
import { getBlobStore } from "../blob/index.js";
import { docKeys } from "../slug.js";
import type { ClusterSink, PreparedDoc, UpsertResult } from "../types.js";
import type { Embedder } from "../embed/index.js";
import { getEmbedder } from "../embed/index.js";
import { ClusterClient, type IndexChunkInput } from "./client.js";
import { bnfDatasetSchema, bnfDatasetSlug } from "./dataset.js";

export interface BnfClusterSinkOptions {
  client?: ClusterClient;
  embedder?: Embedder;
  blob?: BlobStore;
}

export class BnfClusterSink implements ClusterSink {
  private readonly client: ClusterClient;
  private readonly embedder: Embedder;
  private readonly blob: BlobStore;

  constructor(opts: BnfClusterSinkOptions = {}) {
    this.client = opts.client ?? new ClusterClient();
    this.embedder = opts.embedder ?? getEmbedder();
    this.blob = opts.blob ?? getBlobStore();
  }

  async ensureDataset(input: {
    projectId: string;
    name: string;
    slug: string;
  }): Promise<{ datasetId: number }> {
    // Caller-provided slug wins; otherwise derive from projectId.
    const slug = input.slug ?? bnfDatasetSlug(input.projectId);
    const existing = await this.client.getDatasetBySlug(slug);
    if (existing) {
      return { datasetId: existing.id };
    }
    const created = await this.client.createDataset({
      name: input.name,
      slug,
      description: `BnF corpus dataset for project ${input.projectId}`,
      dataset_type: "text",
      schema_definition: bnfDatasetSchema(input.projectId),
    });
    return { datasetId: created.id };
  }

  async upsert(input: {
    datasetId: number;
    prepared: PreparedDoc;
    onStage?: (stage: "embedding" | "indexing") => Promise<void>;
  }): Promise<UpsertResult> {
    const { datasetId, prepared, onStage } = input;
    const totalStart = Date.now();

    // 0. Upsert-by-slug: if an entry with our slug already exists,
    //    compare content_hash:
    //      - match  → skip everything, return the existing entry id.
    //      - differ → delete the stale entry, then proceed with a fresh create.
    //    This is the "idempotent re-ingest" path. Track 2's runner ALSO
    //    short-circuits on a matching DocumentIngestState.content_hash, so
    //    this is the second line of defense for cases where the cluster has
    //    state the app doesn't (manual register:one runs, restored backups,
    //    etc.).
    const tLookupStart = Date.now();
    const existing = await this.client.findEntryBySlug(datasetId, prepared.metadata.arkSlug);
    const existingHash =
      (existing?.manifest?.original?.metadata?.["content_hash"] as string | undefined) ?? null;
    if (existing && existingHash === prepared.contentHash) {
      const tTotal = Date.now() - totalStart;
      return {
        entryId: existing.id,
        chunksWritten: 0,
        timings: {
          embed: 0,
          createEntry: 0,
          uploadFile: 0,
          saveProcessed: 0,
          indexChunks: 0,
          total: tTotal,
        },
      };
    }
    if (existing) {
      // Hash mismatch → tombstone the stale entry. The cluster's DELETE
      // cascades through MinIO + Qdrant + Meilisearch (we verified this on
      // entry 1 during dev) so a fresh insert lands cleanly.
      await this.client.deleteEntry(existing.id);
    }
    void tLookupStart;

    // 1. Embed — reuse cached vectors for unchanged content, else embed + cache.
    // Embeddings (RunPod) are the second-most-expensive cost after BnF; caching
    // them by content-hash makes re-indexing a removed/re-added doc embed-free.
    const t0 = Date.now();
    const texts = prepared.chunks.map((c) => c.text);
    const vectorsKey = docKeys(prepared.projectId, prepared.metadata.ark).vectors;
    let vectors = await this.loadCachedVectors(
      vectorsKey,
      prepared.contentHash,
      prepared.chunks.length,
    );
    if (vectors) {
      console.log(
        `[upsert] vector cache hit for ${prepared.metadata.ark} — skipping embed`,
      );
    } else {
      await onStage?.("embedding");
      vectors = await this.embedder.embed(texts);
      if (vectors.length !== prepared.chunks.length) {
        throw new Error(
          `Embedder returned ${vectors.length} vectors for ${prepared.chunks.length} chunks`,
        );
      }
      // Cache for next time (best-effort: a write failure must not fail ingest).
      await this.blob
        .put(
          vectorsKey,
          JSON.stringify({ contentHash: prepared.contentHash, vectors }),
          "application/json; charset=utf-8",
        )
        .catch((e: unknown) =>
          console.warn(
            `[upsert] vector cache write failed for ${prepared.metadata.ark}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
    }
    const tEmbed = Date.now() - t0;

    // 2. Create entry (+ upload + index) — the cluster-write sub-stage.
    await onStage?.("indexing");
    const tCreateStart = Date.now();
    const name = prepared.metadata.title ?? prepared.metadata.ark;
    const description = prepared.markdown.slice(0, 200);
    const entryMetadata: Record<string, unknown> = {
      ...prepared.metadata,
      pipeline: prepared.pipeline,
      content_hash: prepared.contentHash,
    };
    const entry = await this.client.createEntry({
      dataset_id: datasetId,
      name,
      slug: prepared.metadata.arkSlug,
      description,
      metadata: entryMetadata,
    });
    const tCreate = Date.now() - tCreateStart;

    // 3. Upload doc.md
    const tUploadStart = Date.now();
    await this.client.uploadOriginalFile(
      entry.id,
      "doc.md",
      Buffer.from(prepared.markdown, "utf8"),
      "original",
    );
    const tUpload = Date.now() - tUploadStart;

    // 4. Save processed content
    const tProcStart = Date.now();
    await this.client.saveProcessedContent(entry.id, prepared.markdown);
    const tProc = Date.now() - tProcStart;

    // 5. Index chunks
    const tIndexStart = Date.now();
    const indexChunks: IndexChunkInput[] = prepared.chunks.map((c, i) => {
      // Per-chunk metadata: caller-supplied + canonical snake_case keys for
      // the cluster's filter language.
      const md: Record<string, unknown> = {
        ...c.metadata,
        ark: c.metadata.ark,
        ark_slug: c.metadata.arkSlug,
        doc_type: c.metadata.docType ?? prepared.metadata.docType ?? null,
        sub_type: c.metadata.subtype ?? prepared.metadata.subtype ?? null,
        char_start: c.charStart,
        char_end: c.charEnd,
      };
      if (typeof c.metadata.folio === "number") {
        md.folio = c.metadata.folio;
      }
      return {
        chunk_text: c.text,
        chunk_index: c.chunkIndex,
        embedding: vectors[i]!,
        metadata: md,
      };
    });
    await this.client.indexChunks(entry.id, indexChunks, "entry_chunks");
    const tIndex = Date.now() - tIndexStart;

    return {
      entryId: entry.id,
      chunksWritten: indexChunks.length,
      timings: {
        embed: tEmbed,
        createEntry: tCreate,
        uploadFile: tUpload,
        saveProcessed: tProc,
        indexChunks: tIndex,
        total: Date.now() - totalStart,
      },
    };
  }

  /**
   * Remove a document's entry by ARK slug (corpus-delta removal). Idempotent:
   * an already-absent entry returns `{ removed: false }` without error. The
   * cluster DELETE cascades through MinIO + Qdrant + Meilisearch.
   */
  async removeEntry(input: {
    datasetId: number;
    arkSlug: string;
  }): Promise<{ removed: boolean }> {
    const existing = await this.client.findEntryBySlug(
      input.datasetId,
      input.arkSlug,
    );
    if (!existing) return { removed: false };
    await this.client.deleteEntry(existing.id);
    return { removed: true };
  }

  /**
   * Load cached embedding vectors for a doc, or null if absent / stale / corrupt.
   * Keyed implicitly by ark (the blob path) and validated by content-hash so a
   * doc whose content changed re-embeds rather than reusing stale vectors. A
   * chunk-count mismatch is also treated as stale.
   */
  private async loadCachedVectors(
    key: string,
    contentHash: string,
    expectedCount: number,
  ): Promise<number[][] | null> {
    const buf = await this.blob.get(key);
    if (!buf) return null;
    try {
      const o = JSON.parse(buf.toString("utf8")) as {
        contentHash?: string;
        vectors?: unknown;
      };
      if (o.contentHash !== contentHash) return null;
      if (!Array.isArray(o.vectors) || o.vectors.length !== expectedCount) {
        return null;
      }
      return o.vectors as number[][];
    } catch {
      return null;
    }
  }
}
