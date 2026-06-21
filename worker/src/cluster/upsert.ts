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
import type { ClusterSink, PreparedDoc, UpsertResult } from "../types.js";
import type { Embedder } from "../embed/index.js";
import { getEmbedder } from "../embed/index.js";
import { ClusterClient, type IndexChunkInput } from "./client.js";
import { bnfDatasetSchema, bnfDatasetSlug } from "./dataset.js";

export interface BnfClusterSinkOptions {
  client?: ClusterClient;
  embedder?: Embedder;
}

export class BnfClusterSink implements ClusterSink {
  private readonly client: ClusterClient;
  private readonly embedder: Embedder;

  constructor(opts: BnfClusterSinkOptions = {}) {
    this.client = opts.client ?? new ClusterClient();
    this.embedder = opts.embedder ?? getEmbedder();
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

    // 1. Embed
    await onStage?.("embedding");
    const t0 = Date.now();
    const texts = prepared.chunks.map((c) => c.text);
    const vectors = await this.embedder.embed(texts);
    if (vectors.length !== prepared.chunks.length) {
      throw new Error(
        `Embedder returned ${vectors.length} vectors for ${prepared.chunks.length} chunks`,
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
}
