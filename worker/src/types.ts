/**
 * SHARED CONTRACT TYPES — FROZEN.
 *
 * Track 1 (prepare) PRODUCES `PreparedDoc | SkipReason`.
 * Track 3 (embed + cluster) CONSUMES `PreparedDoc` and PRODUCES `UpsertResult`.
 * Track 2 (queue + worker) ORCHESTRATES Track 1 → Track 3; touches no types here.
 *
 * Do NOT add fields ad-hoc — discuss in the wiring step.
 */

/** Which extraction pipeline a document went through. */
export type Pipeline =
  | "text_with_ocr" // BnF has OCR; we fetched the text and rendered Markdown
  | "single_image"; // No OCR but it's a single visual; Holo2 produced a description

/** Why a document was not prepared. Always carries an explicit reason for the UI. */
export type SkipReason =
  | { skip: true; reason: "no_ocr_and_not_single_image"; arkInfo: BnfDocInfo }
  | { skip: true; reason: "metadata_unavailable"; ark: string; cause: string }
  | { skip: true; reason: "not_digitized"; ark: string; cause: string }
  | { skip: true; reason: "holo_failed"; ark: string; cause: string }
  | { skip: true; reason: "ocr_fetch_failed"; ark: string; cause: string };

/** Minimal document metadata as it leaves the prep step. */
export interface DocMetadata {
  ark: string; // canonical ark:/12148/...
  arkSlug: string; // ark with `/` → `-` for filesystem/object-storage keys
  title: string | null;
  creator: string | null;
  date: string | null; // raw BnF date string (may be a range like "1852-1855")
  docType: string | null; // BnF doc_type (carte, image, monographie, ...)
  lang: string | null; // normalized ISO code (fr, en, la, ...)
  source: string; // "gallica" | "data-bnf" | ...
  iiifManifestUrl: string | null;
  pageCount: number | null;
  ocrAvailable: boolean;
}

/** One chunk ready to be embedded and registered. */
export interface ChunkRow {
  /** 0-based position within the document. */
  chunkIndex: number;
  /** The text that will be embedded. */
  text: string;
  /**
   * Character offsets into the source doc.md body (start inclusive, end exclusive).
   * Useful for highlighting / debugging; not required by the cluster.
   */
  charStart: number;
  charEnd: number;
  /**
   * Per-chunk metadata that travels into the cluster's vector store.
   * MUST carry `ark` and `arkSlug`; SHOULD carry `folio` when known and `docType`.
   * Anything in here becomes filterable at query time.
   */
  metadata: Record<string, unknown> & {
    ark: string;
    arkSlug: string;
    folio?: number;
    docType?: string;
  };
}

/**
 * What Track 1 hands to Track 3.
 * The artifacts (markdown body + raw metadata) are persisted in blob storage
 * under `s3://<bucket>/projects/<projectId>/docs/<arkSlug>/{doc.md,doc.json,chunks.jsonl}`,
 * but the in-memory `PreparedDoc` carries everything Track 3 needs directly.
 */
export interface PreparedDoc {
  skip?: false;
  projectId: string;
  pipeline: Pipeline;
  metadata: DocMetadata;
  /** Full Markdown body — the same content saved to `doc.md`. */
  markdown: string;
  /** Chunks ready for embedding. Already at the chunker's target size/overlap. */
  chunks: ChunkRow[];
  /** sha256 of the canonical doc.json — used to skip re-ingest on identical content. */
  contentHash: string;
  /**
   * Blob keys for the persisted artifacts.
   * Track 3 / Track 2 may reference them for debugging or to re-read on retry.
   */
  blobKeys: {
    docMd: string;
    docJson: string;
    chunksJsonl: string;
  };
}

/** Outcome of pushing a PreparedDoc into the data cluster. */
export interface UpsertResult {
  entryId: number;
  chunksWritten: number;
  /** Per-stage timings for observability. All in ms. */
  timings: {
    embed: number;
    createEntry: number;
    uploadFile: number;
    saveProcessed: number;
    indexChunks: number;
    total: number;
  };
}

/** Subset of bnf_get_document_info we care about. */
export interface BnfDocInfo {
  ark: string;
  title: string | null;
  creator: string | null;
  date: string | null;
  docType: string | null;
  ocrAvailable: boolean;
  pageCount: number | null;
  iiifManifestUrl: string | null;
  raw: Record<string, unknown>;
}

// ----- Functional contracts each track satisfies -----

/** Track 1 implements this. */
export interface DocPipeline {
  /**
   * Resolve metadata, run extraction (OCR or Holo), chunk, persist blobs,
   * return a fully-prepared doc or a typed skip.
   */
  prepare(input: { projectId: string; ark: string }): Promise<PreparedDoc | SkipReason>;
}

/** Track 3 implements this. */
export interface ClusterSink {
  /** Ensure a dataset exists for the project; returns its numeric ID. */
  ensureDataset(input: {
    projectId: string;
    name: string;
    slug: string;
  }): Promise<{ datasetId: number }>;

  /**
   * Embed chunks via RunPod, then create entry + upload .md + save processed
   * content + index chunks (with our pre-computed vectors).
   */
  upsert(input: {
    datasetId: number;
    prepared: PreparedDoc;
    /**
     * Fired as the upsert crosses each real sub-stage boundary, so Track 2 can
     * reflect genuine per-doc progress (embedding vs indexing) instead of one
     * atomic "indexing" lump. Not called when the content-hash short-circuit
     * skips the work.
     */
    onStage?: (stage: "embedding" | "indexing") => Promise<void>;
  }): Promise<UpsertResult>;
}
