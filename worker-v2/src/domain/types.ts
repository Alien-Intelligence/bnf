/**
 * The concrete payloads that flow between stages. Each is a small JSON pointer —
 * heavy bytes live in S3 (see keys.ts), never on the queue. Field names are
 * stable: these ARE the inter-stage contracts.
 */
import type { FolioKind, Lane } from "./queues.js";

/** Seed item: a document to ingest. Enters the metadata stage. */
export interface DocRef {
  projectId: string;
  docJobId: string; // the document_ingest_job_v2 row id (per-doc state lives there)
  ark: string;
  /** The ingest_run this doc belongs to. Null for seed-CLI docs (no run/callback);
   *  set for every doc admitted through the HTTP ingress so the completion detector
   *  and the read-model can scope per run. Flows through every downstream payload. */
  runId?: string | null;
}

/** Document-level plan produced by the metadata stage, carried to the manifest/
 *  fetch fan-out. `lane` + `pagesExpected` are also written to the doc-state row
 *  so the Monitor knows when the doc is complete. */
export interface DocPlan extends DocRef {
  lane: Lane;
  /** Total folios to fetch (from OAI for text, from the manifest for image lanes). */
  pagesExpected: number;
  /** Catalogue metadata for downstream context/citation (title/creator/date/docType). */
  meta: DocMeta;
}

export interface DocMeta {
  title: string | null;
  creator: string | null;
  date: string | null;
  docType: string | null;
  subtype: string | null;
  lang: string | null;
  pageCount: number | null;
  ocrAvailable: boolean;
}

/** Metadata → manifest hand-off (image lanes only). `pagesExpected` is NOT known
 *  yet — the manifest stage derives it from the canvas list and records the plan. */
export interface ManifestReq extends DocRef {
  lane: Extract<Lane, "vision" | "mistral">;
  meta: DocMeta;
}

/** One folio fetch — the unit of the 300/min BnF fetch stage. */
export interface FolioItem {
  docJobId: string;
  ark: string;
  ordre: number;
  kind: FolioKind;
  lane: Lane;
}

/** Result of one folio fetch, sent to the Monitor for fan-in. */
export interface FolioResult {
  docJobId: string;
  ark: string;
  ordre: number;
  lane: Lane;
  /** true → bytes are in S3 at the kind's key; false → this folio is lost (counts to fail-ratio). */
  ok: boolean;
  /** "" for a legitimately empty/absent folio (e.g. ALTO 404 = no OCR on that page). */
  empty?: boolean;
}

/** Emitted by the Monitor once a doc's folios are all in — routed to its lane. */
export interface DocReady extends DocPlan {
  /** Folios successfully fetched (ordre list), in order. */
  folios: number[];
}

/** A doc with its prepared text pages — the convergence point feeding embed. */
export interface PreparedDoc extends DocRef {
  lane: Lane;
  meta: DocMeta;
  pages: PreparedPage[];
}

export interface PreparedPage {
  ordre: number;
  /** Markdown/plain text: ALTO text (text lane), OCR (mistral), or description (vision). */
  text: string;
}

/** A Mistral batch in flight, polled until complete. */
export interface OcrBatchRef extends DocRef {
  lane: "mistral";
  meta: DocMeta;
  batchId: string;
  /** custom_id → ordre, to realign OCR results to folios. */
  folios: number[];
  /** Poll iteration — incremented each re-enqueue; caps runaway polling. */
  pollAttempt?: number;
}

/** A doc whose pages are embedded — feeds registration. */
export interface EmbeddedDoc extends DocRef {
  meta: DocMeta;
  /** S3 key where the embeddings landed (heavy → not inlined). */
  embeddingsKey: string;
  pageCount: number;
}
