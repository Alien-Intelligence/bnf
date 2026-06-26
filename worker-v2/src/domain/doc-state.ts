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
  /** Aggregate status counts for the progress read-model, optionally scoped by
   *  project or run (omit the scope for an unscoped global count). */
  statusCounts(scope?: DocScope): Promise<Record<DocStatus, number>>;
  /** The failed docs of a run — feeds the terminal callback's `errors[]`. */
  listFailedDocs(runId: string): Promise<FailedDoc[]>;
  /** Total ok folios (registered pages) across the `done` docs of a run — the
   *  terminal callback's display-only `chunksWritten`. */
  donePageCount(runId: string): Promise<number>;
}
