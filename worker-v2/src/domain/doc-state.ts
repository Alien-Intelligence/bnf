/**
 * Per-doc state — the stateful join the Monitor needs (the rest of the pipeline
 * is stateless). Tracks each doc's lane, expected folio count, and which folios
 * have landed, so the Monitor can decide "doc complete?" and apply the per-doc
 * fail-ratio. Folio recording is **idempotent per (docJobId, ordre)** so a
 * redelivered FolioResult never double-counts.
 *
 * Two implementations (memory for tests, pg for prod) behind one interface.
 */
import type { Lane } from "./queues.js";
import type { DocMeta } from "./types.js";

export type DocStatus =
  | "queued"
  | "planned"
  | "fetching"
  | "ready"
  | "processing"
  | "done"
  | "failed"
  | "skipped"
  | "excluded";

export interface DocRow {
  docJobId: string;
  runId: string | null;
  projectId: string;
  ark: string;
  lane: Lane | null;
  status: DocStatus;
  pagesExpected: number | null;
  pagesDone: number;
  pagesFailed: number;
  meta: DocMeta | null;
  error: string | null;
  skipReason: string | null;
  /** How many times the reconciliation sweep has re-driven this doc (see
   *  `incrementRequeues`); 0 for a doc that has never orphaned. */
  requeues: number;
  /**
   * How many of this doc's OCR pages were discarded as unusable (hallucinated
   * or blank) despite the doc otherwise completing (F13,
   * ai-memories/tech/repos/bnf/ingest-hardening) — 0 for a doc with no drops.
   * Set by `recordPageDrops`, never by `recordFolio` (a dropped OCR page still
   * "landed ok" at the folio-fetch level; this counts a LATER, OCR-stage loss).
   */
  pagesDropped: number;
  /** Short cause description for `pagesDropped` (e.g. "hallucination
   *  détectée"); null while `pagesDropped` is 0. */
  dropReason: string | null;
}

/** The non-terminal doc statuses — a doc in one of these still owes the run work. */
export const NON_TERMINAL_STATUSES: readonly DocStatus[] = [
  "queued",
  "planned",
  "fetching",
  "ready",
  "processing",
];

/** One recorded folio outcome (the fan-in rows), ordre-ascending. */
export interface FolioRecord {
  ordre: number;
  ok: boolean;
}

/** One failed doc, for the terminal callback's `errors[]` (ark + lane-as-stage + reason). */
export interface FailedDoc {
  ark: string;
  lane: Lane | null;
  error: string | null;
}

/** Scope for the aggregate read queries — by project, by run, or unscoped. */
export interface DocScope {
  projectId?: string;
  runId?: string;
}

/** A `done` doc that lost pages to the OCR-stage honesty drop (F13) — feeds the
 *  terminal callback's warning channel (buildTerminalEvent). */
export interface DroppedPagesDoc {
  ark: string;
  lane: Lane | null;
  pagesDropped: number;
  pagesExpected: number | null;
  dropReason: string | null;
}

export interface FolioTally {
  expected: number;
  done: number; // folios that landed ok (incl. legitimately-empty)
  failed: number; // folios that exhausted retries / were lost
  complete: boolean; // (done + failed) >= expected
}

export interface DocStateStore {
  /** Create/seed a doc row (idempotent on docJobId). `runId` groups the doc into
   *  its ingest_run; null/omitted for seed-CLI docs that have no run. */
  upsertDoc(d: {
    docJobId: string;
    projectId: string;
    ark: string;
    runId?: string | null;
  }): Promise<void>;
  /**
   * Batch-seed doc rows for a run's ARKs in one round trip instead of N
   * sequential `upsertDoc` awaits — seeding hundreds of docs one at a time
   * can straddle the app's client timeout on `POST /ingest` (audit finding
   * F19). Same idempotency contract as `upsertDoc` (a no-op per already-seen
   * docJobId).
   */
  upsertDocs(
    refs: {
      docJobId: string;
      projectId: string;
      ark: string;
      runId?: string | null;
    }[],
  ): Promise<void>;
  /** Record the plan from the metadata stage: lane, expected folio count, meta. */
  recordPlan(
    docJobId: string,
    plan: { lane: Lane; pagesExpected: number; meta: DocMeta },
  ): Promise<void>;
  /**
   * Record one folio outcome (idempotent per ordre). Returns the live tally so the
   * Monitor can decide completeness + fail-ratio.
   */
  recordFolio(docJobId: string, ordre: number, ok: boolean): Promise<FolioTally>;
  /** Set a terminal/intermediate status (+ optional error/skipReason). */
  setStatus(
    docJobId: string,
    status: DocStatus,
    extra?: { error?: string; skipReason?: string },
  ): Promise<void>;
  /**
   * Atomically transition to `status` ONLY if the doc is still pre-routed
   * (queued/planned/fetching). Returns true iff THIS call won the transition —
   * so the Monitor routes a completed doc exactly once even if a folio result is
   * redelivered after completion. Concurrency-safe (a conditional UPDATE in pg).
   */
  claimRoute(
    docJobId: string,
    status: "ready" | "failed",
    extra?: { error?: string; skipReason?: string },
  ): Promise<boolean>;
  get(docJobId: string): Promise<DocRow | null>;
  /** Sorted ordres of folios that landed ok — the doc's usable pages. */
  listOkFolios(docJobId: string): Promise<number[]>;
  /**
   * EVERY recorded folio of a doc (ok and lost), ordre-ascending. The
   * reconciliation sweep needs the lost ones too: a lost folio already reached the
   * Monitor's counter, so re-fetching it would be wasted BnF quota — only the
   * ordres with NO row at all are missing work.
   */
  listFolios(docJobId: string): Promise<FolioRecord[]>;
  /**
   * The run's docs that are still non-terminal (NON_TERMINAL_STATUSES) — the
   * sweep's candidate set. Ordered by ark for stable logs.
   */
  listNonTerminalDocs(runId: string): Promise<DocRow[]>;
  /**
   * Count one reconciliation re-drive of this doc and return the NEW total.
   * Incremented BEFORE the re-enqueue, so a send that itself keeps failing still
   * walks toward the cap instead of looping forever.
   */
  incrementRequeues(docJobId: string): Promise<number>;
  /** Aggregate status counts for the progress read-model, optionally scoped by
   *  project or run (omit the scope for an unscoped global count). */
  statusCounts(scope?: DocScope): Promise<Record<DocStatus, number>>;
  /** The failed docs of a run — feeds the terminal callback's `errors[]`. */
  listFailedDocs(runId: string): Promise<FailedDoc[]>;
  /**
   * Record that `drop.dropped` of a doc's `drop.expected` OCR pages were
   * discarded as unusable (F13) even though the doc has ≥1 surviving page and
   * proceeds. `drop.dropped` is clamped to `drop.expected` defensively.
   * Idempotent-by-overwrite: a redelivered poll simply re-records the same
   * tally. Never fails the doc — that decision belongs to the caller
   * (stages/ocr-poll.ts): zero survivors is a `setStatus(..., "failed")`
   * instead, not a `recordPageDrops` call.
   */
  recordPageDrops(
    docJobId: string,
    drop: { dropped: number; expected: number; reason: string },
  ): Promise<void>;
  /**
   * Docs of a run that finished `done` but lost pages (F13's silent-hollow-RAG
   * fix) — feeds the terminal callback's warning channel (buildTerminalEvent).
   * Ordered by ark for stable logs/output, mirroring `listFailedDocs`.
   */
  listDoneWithDrops(runId: string): Promise<DroppedPagesDoc[]>;
  /** Total ok folios (registered pages) across the `done` docs of a run — the
   *  terminal callback's display-only `chunksWritten`. */
  donePageCount(runId: string): Promise<number>;
  /**
   * Run-scoped folio tally for the BnF-fetch read-model: `expected` is the sum of
   * pages_expected over the run's planned docs (grows as metadata resolves more
   * docs); `done`/`failed` are landed folios. Unlike the shared pg-boss bucket
   * counts, this is scoped to the run, so a fresh run never inherits stale numbers.
   */
  folioCounts(runId: string): Promise<{ expected: number; done: number; failed: number }>;
  /** The doc_job_ids belonging to a run — used to run-scope the shared pg-boss
   *  bucket counts (every job payload carries its docJobId). */
  docJobIdsForRun(runId: string): Promise<string[]>;
}
