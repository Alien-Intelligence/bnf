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

/** One folio fetch — the unit of the BnF fetch stages (ALTO and image). */
export interface FolioItem {
  docJobId: string;
  ark: string;
  ordre: number;
  kind: FolioKind;
  lane: Lane;
  /**
   * The canvas's pixel dims from the manifest — the image size is chosen from
   * them (bnf/image-size.ts). Present on every image folio produced by this
   * release (manifest fan-out, sweep rebuild); absent on ALTO folios and on
   * image messages enqueued before it, which fall back to `max` with an
   * `image_dims_unknown` warning.
   */
  canvas?: { width: number | null; height: number | null };
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

// ---------------------------------------------------------------------------
// OCR quality — the per-ARK artifact at keys.ocrQuality(ark)
//
// WIRE CONTRACT shared with the app: models/documents/types.ts
// (workerOcrQualitySyncResponseSchema) validates exactly these shapes and
// values. Change both sides together.
// ---------------------------------------------------------------------------

/**
 * What produced a prepared page's text. Only `alto` pages carry a measured
 * quality (the mean WC); Mistral's own confidence does not flag hallucinations
 * and vision pages are descriptions, so both are recorded as a source with a
 * null quality (plan D2/D3) — never flagged "low".
 */
export const OCR_SOURCE = { ALTO: "alto", MISTRAL: "mistral", VISION: "vision" } as const;
export type OcrSource = (typeof OCR_SOURCE)[keyof typeof OCR_SOURCE];

export interface FolioOcrQuality {
  ordre: number;
  ocrSource: OcrSource;
  /** Mean ALTO word confidence in [0, 1]; null for non-ALTO sources, or ALTO without WC. */
  ocrQuality: number | null;
  /** ALTO word count; null for non-ALTO sources (a Mistral count is not comparable). */
  wordCount: number | null;
}

/**
 * The version of the per-ARK OCR-quality artifact (DocOcrQuality.v). THE RULE:
 * ANY change to the artifact's contract — a field added, removed, renamed or
 * retyped, a value's meaning or scale (e.g. ocrRate as a fraction vs a
 * percentage), the folio shape of ONE lane — bumps it. The app judges every
 * artifact by its own `v` (bnf app lib/cluster/ocr-quality.ts): another
 * version is a deploy mismatch it waits out (`incompatible`), while the
 * expected version failing its schema is that document's artifact broken
 * (rejected, then quarantined). A contract change WITHOUT a bump therefore
 * gets correct artifacts quarantined as broken — or, worse, read with the old
 * meaning when they still parse. helm/DEPLOY.md states the same rule.
 */
export const OCR_QUALITY_ARTIFACT_VERSION = 1;

export interface DocOcrQuality {
  v: typeof OCR_QUALITY_ARTIFACT_VERSION;
  ark: string;
  /** The manifest "Taux OCR" / 100; null when BnF publishes none. */
  ocrRate: number | null;
  lane: Lane;
  /** One entry per PREPARED page (the same set as pages/<slug>.json), ordre-ascending. */
  folios: FolioOcrQuality[];
  /** ISO timestamp of the build. */
  builtAt: string;
}
