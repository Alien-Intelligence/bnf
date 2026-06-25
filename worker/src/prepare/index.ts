/**
 * Track 1 — DocPipeline implementation.
 *
 *   1. Resolve `getDocumentInfo(ark)`.
 *   2. Branch via extract.ts (text_with_ocr | single_image | skip).
 *   3. Render the Markdown body (with `## Folio N` markers on the OCR path).
 *   4. Chunk it (size 1024, overlap 128, folio-aware).
 *   5. Compute the canonical content hash.
 *   6. Persist doc.md / doc.json / chunks.jsonl to the BlobStore.
 *   7. Return PreparedDoc — or the typed SkipReason.
 */
import type { BlobStore } from "../blob/index.js";
import { getBlobStore } from "../blob/index.js";
import { arkToSlug, docKeys } from "../slug.js";
import type {
  ChunkRow,
  DocMetadata,
  DocPipeline,
  PreparedDoc,
  SkipReason,
} from "../types.js";

import { BnfApi } from "./bnf-api.js";
import { chunkMarkdown } from "./chunk.js";
import { PermanentBnfError } from "./errors.js";
import { extract } from "./extract.js";
import { sha256OfCanonical } from "./hash.js";
import { renderImagePagesMarkdown, renderOcrMarkdown } from "./render.js";

export interface PreparePipelineOptions {
  /** Override blob store (tests). Defaults to the env-configured store. */
  blob?: BlobStore;
  /** Override Gallica HTTP client (tests). */
  bnf?: BnfApi;
  /** Max pages to fetch on the OCR path. */
  maxOcrPages?: number;
  /** Max canvases to describe via Holo2 on the image path. */
  maxImageCanvases?: number;
  /** Concurrent Holo2 calls on the image path. */
  imageConcurrency?: number;
}

class PreparePipeline implements DocPipeline {
  private readonly blob: BlobStore;
  private readonly bnf: BnfApi;
  private readonly maxOcrPages?: number;
  private readonly maxImageCanvases?: number;
  private readonly imageConcurrency?: number;
  /** True if we own `this.bnf` and should close it after each prepare(). */
  private readonly ownsApi: boolean;

  constructor(opts: PreparePipelineOptions = {}) {
    this.blob = opts.blob ?? getBlobStore();
    this.bnf = opts.bnf ?? new BnfApi();
    this.ownsApi = opts.bnf === undefined;
    this.maxOcrPages = opts.maxOcrPages;
    this.maxImageCanvases = opts.maxImageCanvases;
    this.imageConcurrency = opts.imageConcurrency;
  }

  async prepare(input: {
    projectId: string;
    ark: string;
  }): Promise<PreparedDoc | SkipReason> {
    const { projectId, ark } = input;
    try {
      return await this.runOnce(projectId, ark);
    } finally {
      if (this.ownsApi) {
        await this.bnf.close().catch(() => {});
      }
    }
  }

  private async runOnce(
    projectId: string,
    ark: string,
  ): Promise<PreparedDoc | SkipReason> {
    // ---- 0) Processed-doc cache ----
    // If a previous prepare() persisted this doc's artifacts (doc.json + doc.md
    // + chunks.jsonl), reconstruct the PreparedDoc from the blob and SKIP the
    // BnF round-trip entirely. This is what makes re-adding a removed doc cheap:
    // the expensive cost is BnF (metadata + per-page OCR), not registration.
    const cached = await this.loadCachedPrepared(projectId, ark);
    if (cached) {
      console.log(`[prepare] cache hit for ${ark} — skipping BnF`);
      return cached;
    }

    // ---- 1) Document info ----
    //
    // Permanent errors (404, bad ARK) become a SkipReason — the doc is never
    // going to exist, no point retrying. Transient errors propagate up so
    // pg-boss can retry the whole doc-job at its layer.
    let info;
    try {
      info = await this.bnf.getDocumentInfo(ark);
    } catch (e) {
      if (e instanceof PermanentBnfError) {
        // A catalogue notice (cb*) is not a missing-metadata problem — it's a
        // doc that can never be ingested. Surface it as its own skip reason so
        // the UI reads it as "skipped: not digitized", not a generic failure.
        if (e.cause === "not_digitized") {
          return {
            skip: true,
            reason: "not_digitized",
            ark,
            cause: e.message,
          };
        }
        return {
          skip: true,
          reason: "metadata_unavailable",
          ark,
          cause: `getDocumentInfo permanent: ${e.cause}`,
        };
      }
      throw e;
    }

    // ---- 2) Branch ----
    const ext = await extract(this.bnf, info, {
      maxOcrPages: this.maxOcrPages,
      maxImageCanvases: this.maxImageCanvases,
      imageConcurrency: this.imageConcurrency,
    });
    if (ext.kind === "skip") return ext.reason;

    // ---- 3) Render ----
    let markdown: string;
    let pipeline: "text_with_ocr" | "single_image";
    // Per-folio metadata stamped onto each chunk by the chunker. The image
    // path needs this so each chunk carries its canvas's iiif_url for citation.
    const folioMetadata = new Map<number, Record<string, unknown>>();
    if (ext.kind === "text_with_ocr") {
      markdown = renderOcrMarkdown(info, ext.pages);
      pipeline = "text_with_ocr";
    } else {
      markdown = renderImagePagesMarkdown(info, ext.pages, {
        totalCanvases: ext.totalCanvases,
        cappedAt: ext.cappedAt,
      });
      pipeline = "single_image";
      for (const page of ext.pages) {
        folioMetadata.set(page.ordre, {
          iiif_url: page.iiifUrl,
          canvas_label: page.label,
        });
      }
    }

    // ---- 4) Metadata + chunks ----
    const arkSlug = arkToSlug(info.ark);
    // We don't have explicit lang/source from getDocumentInfo's reduced shape;
    // pull what we can from raw, fall back to defaults.
    const rawLang = (info.raw["language"] as string | undefined) ?? null;
    const metadata: DocMetadata = {
      ark: info.ark,
      arkSlug,
      title: info.title,
      creator: info.creator,
      date: info.date,
      docType: info.docType,
      subtype: info.subtype,
      lang: rawLang,
      source: "gallica",
      iiifManifestUrl: info.iiifManifestUrl,
      pageCount: info.pageCount,
      ocrAvailable: info.ocrAvailable,
    };

    const chunks: ChunkRow[] = chunkMarkdown(markdown, {
      baseMetadata: {
        ark: info.ark,
        arkSlug,
        docType: info.docType ?? undefined,
        subtype: info.subtype ?? undefined,
      },
      folioMetadata: folioMetadata.size > 0 ? folioMetadata : undefined,
    });

    // ---- 5) Content hash ----
    // Canonical payload for hashing = metadata + chunkCount. Chunks themselves
    // are derived from `markdown`, so hashing the chunk count + metadata is
    // sufficient to detect a re-prepare with identical inputs.
    const hashPayload = { ...metadata, chunkCount: chunks.length };
    const contentHash = sha256OfCanonical(hashPayload);

    // ---- 6) Persist ----
    // doc.json mirrors the PreparedDoc shape (sans `markdown` + `chunks`) so
    // Track 3's loader can reconstruct a PreparedDoc with no field gymnastics.
    const keys = docKeys(projectId, info.ark);
    const docJsonPayload = {
      projectId,
      pipeline,
      metadata,
      contentHash,
      blobKeys: keys,
      chunkCount: chunks.length,
    };
    const docJsonString = JSON.stringify(docJsonPayload, null, 2);
    const chunksJsonl = chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length > 0 ? "\n" : "");

    await Promise.all([
      this.blob.put(keys.docMd, markdown, "text/markdown; charset=utf-8"),
      this.blob.put(keys.docJson, docJsonString, "application/json; charset=utf-8"),
      this.blob.put(keys.chunksJsonl, chunksJsonl, "application/x-ndjson; charset=utf-8"),
    ]);

    // ---- 7) Done ----
    const prepared: PreparedDoc = {
      skip: false,
      projectId,
      pipeline,
      metadata,
      markdown,
      chunks,
      contentHash,
      blobKeys: keys,
    };
    return prepared;
  }

  /**
   * Reconstruct a PreparedDoc from the blob cache (doc.json + doc.md +
   * chunks.jsonl) written by a prior prepare(), or null if any artifact is
   * missing / corrupt. doc.json deliberately mirrors the PreparedDoc shape
   * (sans markdown + chunks), so reconstruction is gymnastics-free. A chunk-count
   * mismatch is treated as a stale cache → null (re-prepare from BnF).
   */
  private async loadCachedPrepared(
    projectId: string,
    ark: string,
  ): Promise<PreparedDoc | null> {
    const keys = docKeys(projectId, ark);
    const [docJsonBuf, mdBuf, chunksBuf] = await Promise.all([
      this.blob.get(keys.docJson),
      this.blob.get(keys.docMd),
      this.blob.get(keys.chunksJsonl),
    ]);
    if (!docJsonBuf || !mdBuf || !chunksBuf) return null;
    try {
      const meta = JSON.parse(docJsonBuf.toString("utf8")) as {
        pipeline: PreparedDoc["pipeline"];
        metadata: DocMetadata;
        contentHash: string;
        chunkCount: number;
      };
      const markdown = mdBuf.toString("utf8");
      const chunks: ChunkRow[] = chunksBuf
        .toString("utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as ChunkRow);
      if (chunks.length !== meta.chunkCount) return null;
      return {
        skip: false,
        projectId,
        pipeline: meta.pipeline,
        metadata: meta.metadata,
        markdown,
        chunks,
        contentHash: meta.contentHash,
        blobKeys: keys,
      };
    } catch {
      return null;
    }
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Convenience factory. Track 2's worker root composes its own instance. */
export function createPreparePipeline(opts: PreparePipelineOptions = {}): DocPipeline {
  return new PreparePipeline(opts);
}

export { PreparePipeline };
export default createPreparePipeline;
