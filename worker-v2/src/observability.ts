/**
 * Progress read-model — a pure aggregation over what the pipeline already
 * persists: the per-doc status counts (DocStateStore) + each bucket's job-state
 * counts (QueueClient.counts). No new tracking infra. This is the payload the
 * Ingérer UI polls.
 *
 * Design invariant (the anti-V1 rule): `failed` / `skipped` / `excluded` are
 * ALWAYS surfaced and the doc totals ALWAYS reconcile —
 *   done + running + queued + failed + skipped + excluded = total.
 * A UI that shows only done/running/queued lies about completion; this model
 * refuses to. ETA = BnF-fetch bucket depth ÷ fetch rate + the one-time Mistral
 * tail, so a long batch wait reads as "~Xh remaining", not a hang.
 */
import type { DocStateStore, DocStatus } from "./domain/doc-state.js";
import type { QueueClient } from "./core/types.js";
import { Q } from "./domain/queues.js";

export interface StageProgress {
  done: number;
  running: number;
  queued: number;
  failed: number;
}

export interface ProgressReport {
  /** Per-doc terminal/in-flight status (the headline reconciliation). */
  docs: Record<DocStatus, number>;
  docsTotal: number;
  /** "Docs finished" headline — docs fully registered. */
  docsFinished: number;
  /** Per-stage bucket counts, keyed by stage name. */
  stages: Record<string, StageProgress>;
  /** Run-scoped BnF-fetch folio tally — the honest récupérés/total for the fetch
   *  headline (NOT the shared pg-boss bucket counts, which accumulate across runs). */
  folios: { expected: number; done: number; failed: number };
  /** Folios from OTHER concurrent runs still pending in the shared BnF-fetch queue
   *  (active + queued, run-excluded). The 300/1000-per-min cap is shared, so this is
   *  the work "ahead of you" — surfaced so a contended run reads as "N en attente
   *  devant vous", not as a stall. 0 when this run has the queue to itself. */
  foliosAhead: number;
  /** The binding BnF fetch rate (folios/min) the ETA assumes — surfaced so the UI
   *  can headline the constraint ("≈ 300/min"). */
  fetchRatePerMin: number;
  /** The IIIF manifest rate (manifests/min) — the binding cap on the metadata
   *  lane's image-doc sub-stage. Surfaced so the UI shows the rate, not just the
   *  in-flight concurrency. */
  manifestRatePerMin: number;
  /** Estimated seconds remaining (fetch backlog ÷ rate + Mistral tail), or null. */
  etaSeconds: number | null;
  /** Paid Mistral OCR spend so far / budget (USD), when a budget is configured. */
  paidOcr?: { spentUsd: number; budgetUsd: number | null };
  /** True iff the doc totals reconcile — a guard the caller can assert/log. */
  reconciles: boolean;
}

export interface ProgressOpts {
  projectId?: string;
  /** Scope the doc-status reconciliation to one ingest_run (the Ingérer poll path).
   *  Takes precedence over projectId. Note: the per-stage bucket counts come from the
   *  shared pg-boss queues and are NOT run-scoped — fine for the prototype's
   *  one-run-at-a-time cadence; the headline doc reconciliation IS run-scoped. */
  runId?: string;
  /** BnF fetch rate (folios/min) for the ETA — 300 today, 1000 if the raise lands. */
  fetchRatePerMin?: number;
  /** IIIF manifest rate (manifests/min) — surfaced on the metadata row (default 42). */
  manifestRatePerMin?: number;
  /** One-time Mistral batch tail (seconds) added to the ETA when OCR work is queued. */
  mistralTailSeconds?: number;
  paidOcr?: { spentUsd: number; budgetUsd: number | null };
}

/** The buckets surfaced in the UI, in pipeline order. */
const STAGE_QUEUES: Array<{ key: string; queue: string }> = [
  { key: "metadata", queue: Q.metadata },
  { key: "manifest", queue: Q.manifest },
  { key: "fetch", queue: Q.fetch },
  { key: "assemble", queue: Q.assemble },
  { key: "describe", queue: Q.describe },
  { key: "ocrSubmit", queue: Q.ocrSubmit },
  { key: "ocrPoll", queue: Q.ocrPoll },
  { key: "embed", queue: Q.embed },
  { key: "register", queue: Q.register },
];

export async function buildProgress(
  docState: DocStateStore,
  queue: QueueClient,
  opts: ProgressOpts = {},
): Promise<ProgressReport> {
  const docs = await docState.statusCounts(
    opts.runId !== undefined
      ? { runId: opts.runId }
      : opts.projectId !== undefined
        ? { projectId: opts.projectId }
        : undefined,
  );
  const docsTotal = (Object.values(docs) as number[]).reduce((a, b) => a + b, 0);

  // RUN-SCOPE the per-stage bucket counts. The pg-boss buckets are SHARED across
  // concurrently-running ingests, so the global counts would show one run's
  // describe/OCR activity on another run's card (the live "job 2 shows job 1's
  // numbers" bug). Every job payload carries its docJobId, so we count only the
  // jobs belonging to THIS run's docs. Without a runId (the status CLI) we fall
  // back to the global counts.
  const docJobIds = opts.runId ? await docState.docJobIdsForRun(opts.runId) : null;
  const stages: Record<string, StageProgress> = {};
  for (const { key, queue: name } of STAGE_QUEUES) {
    const c = docJobIds ? await queue.countsForDocs(name, docJobIds) : await queue.counts(name);
    stages[key] = { done: c.completed, running: c.running, queued: c.queued, failed: c.failed };
  }

  // Folios from OTHER runs still pending in the shared fetch queue = global pending
  // − this run's pending. The fetch rate cap is shared, so this is the work ahead of
  // you. Only meaningful when run-scoped.
  let foliosAhead = 0;
  if (docJobIds) {
    const globalFetch = await queue.counts(Q.fetch);
    const globalPending = globalFetch.running + globalFetch.queued;
    const runPending = (stages.fetch?.running ?? 0) + (stages.fetch?.queued ?? 0);
    foliosAhead = Math.max(0, globalPending - runPending);
  }

  // ETA: the binding stage is BnF fetch (your backlog + the folios queued AHEAD of
  // you, since the rate cap is shared) ÷ rate. Add the one-time Mistral tail only
  // while OCR work is still in flight.
  const rate = opts.fetchRatePerMin ?? 300;
  const fetchBacklog =
    (stages.fetch?.queued ?? 0) + (stages.fetch?.running ?? 0) + foliosAhead;
  let etaSeconds: number | null = rate > 0 ? Math.ceil((fetchBacklog / rate) * 60) : null;
  const ocrInFlight =
    (stages.ocrSubmit?.queued ?? 0) +
    (stages.ocrSubmit?.running ?? 0) +
    (stages.ocrPoll?.queued ?? 0) +
    (stages.ocrPoll?.running ?? 0);
  if (etaSeconds !== null && ocrInFlight > 0) {
    etaSeconds += opts.mistralTailSeconds ?? 25 * 60;
  }

  const reconciles = docsTotal === sumStatuses(docs);

  // Run-scoped folio tally for the fetch headline. Only meaningful with a runId
  // (the /progress/:runId path always sets it); the unscoped status CLI gets zeros.
  const folios = opts.runId
    ? await docState.folioCounts(opts.runId)
    : { expected: 0, done: 0, failed: 0 };

  const report: ProgressReport = {
    docs,
    docsTotal,
    docsFinished: docs.done,
    stages,
    folios,
    foliosAhead,
    fetchRatePerMin: rate,
    manifestRatePerMin: opts.manifestRatePerMin ?? 42,
    etaSeconds,
    reconciles,
  };
  if (opts.paidOcr) report.paidOcr = opts.paidOcr;
  return report;
}

function sumStatuses(docs: Record<DocStatus, number>): number {
  const all: DocStatus[] = [
    "queued",
    "planned",
    "fetching",
    "ready",
    "processing",
    "done",
    "failed",
    "skipped",
    "excluded",
  ];
  return all.reduce((n, s) => n + docs[s], 0);
}
