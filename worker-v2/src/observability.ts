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
 * refuses to. ETA = BnF-fetch backlog ÷ fetch rate + the one-time Mistral
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
  /**
   * Per-stage bucket counts, keyed by stage name. `fetch` is the SUM of the two
   * BnF fetch queues (`fetchAlto` + `fetchImage`, also listed), so the app's
   * contract — one `fetch` headline row — is unchanged by the split.
   */
  stages: Record<string, StageProgress>;
  /** Run-scoped BnF-fetch folio tally — the honest récupérés/total for the fetch
   *  headline (NOT the shared pg-boss bucket counts, which accumulate across runs). */
  folios: { expected: number; done: number; failed: number };
  /** Folios from OTHER concurrent runs still pending in the shared BnF fetch queues
   *  (ALTO + image, active + queued, run-excluded). The BnF quotas are shared, so
   *  this is the work "ahead of you" — surfaced so a contended run reads as "N en
   *  attente devant vous", not as a stall. 0 when this run has the queues to itself. */
  foliosAhead: number;
  /** The binding BnF fetch rate (folios/min) the ETA assumes — surfaced so the UI
   *  can headline the constraint. The ALTO rate, min(global, presentation): ALTO
   *  is ≥ 90 % of folios, so image-heavy runs keep an approximate ETA (their
   *  Mistral or vision tail dominates anyway). */
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
  /** BnF fetch rate (folios/min) for the ETA — see ProgressReport.fetchRatePerMin. */
  fetchRatePerMin: number;
  /** IIIF manifest rate (manifests/min) — surfaced on the metadata row. */
  manifestRatePerMin: number;
  /** One-time Mistral batch tail (seconds) added to the ETA when OCR work is queued. */
  mistralTailSeconds?: number;
  paidOcr?: { spentUsd: number; budgetUsd: number | null };
}

/** The two BnF fetch buckets, summed into the `fetch` row. */
const FETCH_STAGE_KEYS = ["fetchAlto", "fetchImage"] as const;

/** The buckets surfaced in the UI, in pipeline order. */
const STAGE_QUEUES: Array<{ key: string; queue: string }> = [
  { key: "metadata", queue: Q.metadata },
  { key: "manifest", queue: Q.manifest },
  { key: "fetchAlto", queue: Q.fetchAlto },
  { key: "fetchImage", queue: Q.fetchImage },
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
  opts: ProgressOpts,
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
  const fetchRow = sumStages(FETCH_STAGE_KEYS.map((k) => stages[k]));
  stages.fetch = fetchRow;

  // Folios from OTHER runs still pending in the shared fetch queues = global
  // pending − this run's pending. The BnF quotas are shared, so this is the work
  // ahead of you. Only meaningful when run-scoped.
  let foliosAhead = 0;
  if (docJobIds) {
    let globalPending = 0;
    for (const name of [Q.fetchAlto, Q.fetchImage]) {
      const c = await queue.counts(name);
      globalPending += c.running + c.queued;
    }
    const runPending = fetchRow.running + fetchRow.queued;
    foliosAhead = Math.max(0, globalPending - runPending);
  }

  // Run-scoped folio tally for the fetch headline + the ETA. Only meaningful with
  // a runId (the /progress/:runId path always sets it); the unscoped status CLI
  // gets zeros.
  const folios = opts.runId
    ? await docState.folioCounts(opts.runId)
    : { expected: 0, done: 0, failed: 0 };

  // ETA: BnF fetch is the binding stage (its rate cap is shared across runs). The
  // remaining work is NOT the current fetch-queue depth — during planning most
  // docs haven't been expanded into folios yet, so that depth is tiny and the ETA
  // would collapse to "moins d'une minute" for an hour-long run (the reported bug).
  // Estimate the run's TOTAL folios by extrapolating the average folios/doc of the
  // already-planned docs across the docs still queued for planning, then subtract
  // what has already landed. Add the one-time Mistral tail while OCR is in flight.
  const rate = opts.fetchRatePerMin;
  const plannedDocs =
    docs.planned + docs.fetching + docs.ready + docs.processing + docs.done;
  const unplannedDocs = docs.queued; // still to be planned → folio count unknown
  let runRemainingFolios: number | null;
  if (docsTotal === 0) {
    // No doc-level state (synthetic / queue-only path): fall back to queue depth.
    runRemainingFolios = fetchRow.queued + fetchRow.running;
  } else if (plannedDocs === 0) {
    // Docs exist but none planned yet → the total is genuinely unknown. Don't
    // fabricate a number: null makes the UI show "estimating…" rather than lie.
    runRemainingFolios = null;
  } else {
    const avgFoliosPerDoc = folios.expected / plannedDocs;
    const estTotalFolios = folios.expected + avgFoliosPerDoc * unplannedDocs;
    runRemainingFolios = Math.max(0, Math.round(estTotalFolios) - folios.done - folios.failed);
  }
  // Fold in the folios queued AHEAD of you (other runs on the shared cap).
  const bindingBacklog = runRemainingFolios === null ? null : runRemainingFolios + foliosAhead;
  let etaSeconds: number | null =
    bindingBacklog !== null && rate > 0 ? Math.ceil((bindingBacklog / rate) * 60) : null;
  const ocrInFlight =
    (stages.ocrSubmit?.queued ?? 0) +
    (stages.ocrSubmit?.running ?? 0) +
    (stages.ocrPoll?.queued ?? 0) +
    (stages.ocrPoll?.running ?? 0);
  if (etaSeconds !== null && ocrInFlight > 0) {
    etaSeconds += opts.mistralTailSeconds ?? 25 * 60;
  }

  const reconciles = docsTotal === sumStatuses(docs);

  const report: ProgressReport = {
    docs,
    docsTotal,
    docsFinished: docs.done,
    stages,
    folios,
    foliosAhead,
    fetchRatePerMin: rate,
    manifestRatePerMin: opts.manifestRatePerMin,
    etaSeconds,
    reconciles,
  };
  if (opts.paidOcr) report.paidOcr = opts.paidOcr;
  return report;
}

/** Element-wise sum of stage counts (a missing stage counts as zero). */
function sumStages(parts: ReadonlyArray<StageProgress | undefined>): StageProgress {
  const sum: StageProgress = { done: 0, running: 0, queued: 0, failed: 0 };
  for (const p of parts) {
    if (!p) continue;
    sum.done += p.done;
    sum.running += p.running;
    sum.queued += p.queued;
    sum.failed += p.failed;
  }
  return sum;
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
