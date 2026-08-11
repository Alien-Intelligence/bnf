/**
 * Reconciliation sweep — the reason no run can wedge any more.
 *
 * Everything else in this worker is EVENT-driven: a doc advances because a stage
 * handler ran, and a run completes because a stage outcome told the completion
 * monitor to look. That is fast and cheap, and it has one fatal hole — if the
 * event never happens, nothing ever looks again:
 *
 *  - a pg-boss job that EXPIRES (the transport kills it from outside) runs no
 *    handler code, so every careful last-attempt idiom in the stages is bypassed
 *    and the doc sits non-terminal forever (F7);
 *  - `checkRun` was reachable only from a live stage outcome, so even after the
 *    orphaned doc was fixed by hand the run stayed un-emitted (F8);
 *  - the recovery CLI only knew how to re-drive `ready` docs (F9).
 *
 * That is exactly how prod run efe5d747 wedged at 464/465 for hours: one redeploy
 * mid-run, one orphaned v2.metadata delivery, one doc stuck in `queued`, and no
 * mechanism anywhere that would ever re-examine it.
 *
 * So: every RECONCILER_INTERVAL_MS (and once at boot), for every run the app is
 * still waiting on:
 *
 *   A. ORPHAN DOCS — a non-terminal doc with NO live pg-boss job carrying its
 *      docJobId owns no work and nothing will ever move it. Re-drive it by status
 *      (re-seed metadata / rebuild the missing folios / re-send the lane message).
 *      Every re-drive is counted; a doc that keeps orphaning without progress
 *      fails terminally (`stranded_after_requeues`) rather than looping forever.
 *   B. RUN COMPLETION — call `checkRun`, whose latch makes the call free when
 *      there is nothing to do and which also re-fires a terminal callback whose
 *      POST failed.
 *
 * Every re-drive is idempotent by construction: the S3 artifact caches make a
 * replayed metadata/manifest/fetch nearly free, the Monitor dedupes folios per
 * (docJobId, ordre), and the register stage dedupes on its receipt. Doing it twice
 * costs a little; not doing it once costs the whole run.
 *
 * Bounded (CLAUDE_ERROR_PATTERNS §14): the sweep never overlaps itself, it is
 * strictly sequential, and every DB/queue call it makes runs on a pool with a
 * `statement_timeout` (see main.ts / queue-pgboss.ts) — pg has no query timeout of
 * its own, and an unbounded sweep would be a new instance of the very bug class
 * this slice exists to close.
 */
import type { BlobStore, Logger, QueueClient } from "../core/types.js";
import type { DocRow, DocStateStore } from "../domain/doc-state.js";
import type { IngestRun, RunStore } from "../domain/run.js";
import { keys } from "../domain/keys.js";
import { LANE_QUEUE, Q, withFetchPriority } from "../domain/queues.js";
import type { Manifest } from "../bnf/types.js";
import type {
  DocReady,
  DocRef,
  FolioItem,
  FolioResult,
  ManifestReq,
} from "../domain/types.js";

/** Every bucket a doc's work can be sitting in — the sweep's liveness lookup. */
const SWEPT_QUEUES: readonly string[] = Object.values(Q);

/** Terminal error prefix for a doc that keeps orphaning. Greppable on purpose. */
export const STRANDED_ERROR = "stranded_after_requeues";

/** The completion seam the sweep needs (CompletionMonitor satisfies it). */
export interface RunCompletionChecker {
  /** True iff this call sent the run's terminal event. */
  checkRun(runId: string): Promise<boolean>;
}

export interface ReconcilerDeps {
  runStore: RunStore;
  docState: DocStateStore;
  queue: QueueClient;
  /** Read-only here: the sweep reads a cached manifest to rebuild image folios. */
  blob: BlobStore;
  completion: RunCompletionChecker;
  log: Logger;
}

export interface ReconcilerOpts {
  /** Sweep cadence in ms (default 60_000). */
  intervalMs?: number;
  /** Re-drives allowed per doc before it fails terminally (default 3). */
  maxRequeues?: number;
}

/** What one sweep did. Logged only when at least one action was taken. */
export interface SweepSummary {
  runs: number;
  docs: number;
  orphans: number;
  requeued: number;
  failed: number;
  emitted: number;
}

const emptySummary = (): SweepSummary => ({
  runs: 0,
  docs: 0,
  orphans: 0,
  requeued: 0,
  failed: 0,
  emitted: 0,
});

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Reconciler {
  private readonly intervalMs: number;
  private readonly maxRequeues: number;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | null = null;
  /** True while a sweep is running — a tick that lands on it is SKIPPED, not queued. */
  private inFlight = false;

  constructor(
    private readonly deps: ReconcilerDeps,
    opts: ReconcilerOpts = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.maxRequeues = opts.maxRequeues ?? 3;
    this.log = deps.log.child({ component: "reconciler" });
  }

  /**
   * Sweep once now (a deploy's first sweep is what un-wedges anything stranded by
   * the previous pod), then every `intervalMs`. The startup sweep is detached: a
   * slow first sweep must not delay the worker coming up.
   */
  start(): void {
    if (this.timer) throw new Error("reconciler already started");
    this.log.info("reconciler_started", {
      intervalMs: this.intervalMs,
      maxRequeues: this.maxRequeues,
    });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One guarded sweep. Never throws (a sweep failure is logged and the next tick
   * retries) and never overlaps a sweep already in progress — with a 60s cadence
   * and a run of several hundred docs, an overlapping sweep would double-requeue
   * the same orphans and burn their requeue budget twice.
   */
  async tick(): Promise<void> {
    if (this.inFlight) {
      this.log.info("reconciler_tick_skipped", { reason: "sweep_in_flight" });
      return;
    }
    this.inFlight = true;
    try {
      await this.sweep();
    } catch (e) {
      this.log.error("reconciler_sweep_failed", { error: errMsg(e) });
    } finally {
      this.inFlight = false;
    }
  }

  /** The sweep proper. Returns its summary (the tests assert on it). */
  async sweep(): Promise<SweepSummary> {
    const s = emptySummary();
    const runs = await this.deps.runStore.listActiveRuns();
    s.runs = runs.length;
    for (const run of runs) {
      await this.reconcileRun(run, s);
    }
    // A quiet sweep logs NOTHING: at 60s cadence an "all clear" line would be
    // 1440 log lines a day saying nothing happened.
    if (s.requeued > 0 || s.failed > 0 || s.emitted > 0) {
      this.log.info("reconciler_sweep", { ...s });
    }
    return s;
  }

  /**
   * Reconcile ONE run — the recovery CLI's entry point (requeue-stranded.ts), so an
   * operator staring at a stuck run runs exactly the same logic as the timer
   * instead of a second, drifting implementation of it.
   */
  async sweepRun(run: IngestRun): Promise<SweepSummary> {
    const s = emptySummary();
    s.runs = 1;
    await this.reconcileRun(run, s);
    return s;
  }

  private async reconcileRun(run: IngestRun, s: SweepSummary): Promise<void> {
    const docs = await this.deps.docState.listNonTerminalDocs(run.runId);
    s.docs += docs.length;

    if (docs.length > 0) {
      // ONE liveness query per run, not per doc.
      //
      // The read-then-check is not atomic, but it cannot mis-fire: every stage
      // writes the doc's terminal status INSIDE its handler and the transport marks
      // the job complete only after the handler returns. So a doc that goes terminal
      // between these two queries still has an `active` job at this instant and
      // reads as live. The window that would matter — "terminal AND no live job" —
      // is a doc that is genuinely finished, and those are never in `docs`.
      const live = await this.deps.queue.liveDocJobIds(
        SWEPT_QUEUES,
        docs.map((d) => d.docJobId),
      );
      for (const doc of docs) {
        if (live.has(doc.docJobId)) continue; // still owned by a queue job
        s.orphans += 1;
        try {
          await this.redrive(doc, s);
        } catch (e) {
          // One un-redrivable doc must not abort the sweep — the rest of the run
          // (and every other run) still needs reconciling.
          this.log.error("reconciler_redrive_failed", {
            docJobId: doc.docJobId,
            ark: doc.ark,
            status: doc.status,
            error: errMsg(e),
          });
        }
      }
    }

    // Step B: always ask, even when nothing was re-driven — the run may have gone
    // fully terminal through a transition whose completion check was itself lost.
    try {
      if (await this.deps.completion.checkRun(run.runId)) {
        s.emitted += 1;
        this.log.info("reconciler_run_checked", { runId: run.runId, emitted: true });
      }
    } catch (e) {
      // A terminal callback whose POST failed released its latch — the next sweep
      // tries again. Logged, never swallowed silently.
      this.log.error("reconciler_run_check_failed", { runId: run.runId, error: errMsg(e) });
    }
  }

  /**
   * Re-drive one orphaned doc, or fail it if it has used up its budget.
   *
   * The counter moves BEFORE the enqueue on purpose: if the send itself is what
   * keeps failing, the doc still walks toward the cap instead of being re-driven
   * forever.
   */
  private async redrive(doc: DocRow, s: SweepSummary): Promise<void> {
    if (doc.requeues >= this.maxRequeues) {
      const reason = `${STRANDED_ERROR}: ${doc.status} requeued ${doc.requeues}x without progress`;
      await this.deps.docState.setStatus(doc.docJobId, "failed", { error: reason });
      s.failed += 1;
      this.log.error("reconciler_doc_failed", {
        docJobId: doc.docJobId,
        ark: doc.ark,
        status: doc.status,
        requeues: doc.requeues,
        reason,
      });
      return;
    }

    const requeues = await this.deps.docState.incrementRequeues(doc.docJobId);
    const target = await this.enqueueFor(doc);
    s.requeued += 1;
    this.log.warn("reconciler_requeued", {
      docJobId: doc.docJobId,
      ark: doc.ark,
      status: doc.status,
      requeues,
      target,
    });
  }

  /**
   * Put the doc's work back on the right bucket for where it had got to. Returns a
   * short description of what was enqueued, for the log line.
   */
  private async enqueueFor(doc: DocRow): Promise<string> {
    switch (doc.status) {
      case "queued":
        return await this.reseedMetadata(doc);

      case "planned":
      case "fetching":
        // The plan exists but the folio fan-out died mid-flight. Without
        // pagesExpected there is no plan to rebuild from — an inconsistent row, so
        // start the doc over from the head of the pipeline (idempotent, cached).
        if (doc.pagesExpected == null) return await this.reseedMetadata(doc);
        return await this.rebuildFolios(doc, doc.pagesExpected);

      case "ready":
      case "processing":
        return await this.requeueLane(doc);

      // listNonTerminalDocs only ever returns the five above; a terminal doc
      // reaching here would mean the store's contract broke, so say so loudly
      // rather than silently doing nothing.
      default:
        throw new Error(`reconciler: doc ${doc.docJobId} has terminal status ${doc.status}`);
    }
  }

  /** Head of the pipeline: the exact DocRef shape the ingress seeds. */
  private async reseedMetadata(doc: DocRow): Promise<string> {
    const ref: DocRef = {
      projectId: doc.projectId,
      docJobId: doc.docJobId,
      ark: doc.ark,
      runId: doc.runId,
    };
    await this.deps.queue.send(Q.metadata, ref);
    return Q.metadata;
  }

  /**
   * Re-enqueue the folios that never landed — NOT the whole fan-out. A folio with
   * a row in document_folio_v2 already reached the Monitor's counter (ok OR lost),
   * so re-fetching it would spend scarce BnF quota to record something already
   * recorded.
   *
   * Two special cases:
   *  - image lanes take their ordres from the CANVAS list, which is not
   *    necessarily 1..N (the ordre comes from the IIIF canvas id). So we read the
   *    cached manifest; with no cached manifest there is nothing to derive them
   *    from, and the honest re-drive is the manifest stage itself.
   *  - all folios landed but the doc is still `planned`/`fetching` → the folios
   *    are fine and it is the MONITOR's message that died. Re-sending one recorded
   *    folio result re-runs the fan-in (recordFolio is ON CONFLICT DO NOTHING, so
   *    the tally is unchanged) and the doc routes.
   */
  private async rebuildFolios(doc: DocRow, pagesExpected: number): Promise<string> {
    const lane = doc.lane;
    if (!lane) return await this.reseedMetadata(doc); // planned without a lane: inconsistent

    let expected: number[];
    if (lane === "text") {
      // The text fan-out is folios 1..pagesExpected (MetadataStage builds exactly
      // that), so the ordres are known without reading anything.
      expected = Array.from({ length: pagesExpected }, (_, i) => i + 1);
    } else {
      const ordres = await this.canvasOrdres(doc.ark, pagesExpected);
      if (!ordres) {
        if (!doc.meta) return await this.reseedMetadata(doc);
        const req: ManifestReq = {
          projectId: doc.projectId,
          docJobId: doc.docJobId,
          ark: doc.ark,
          runId: doc.runId,
          lane,
          meta: doc.meta,
        };
        await this.deps.queue.send(Q.manifest, req);
        return `${Q.manifest} (no cached manifest to rebuild folios from)`;
      }
      expected = ordres;
    }

    const recorded = await this.deps.docState.listFolios(doc.docJobId);
    const landed = new Set(recorded.map((f) => f.ordre));
    const missing = expected.filter((ordre) => !landed.has(ordre));

    if (missing.length === 0) {
      const last = recorded[recorded.length - 1];
      if (!last) {
        // No expected folios AND none recorded — nothing to fan out at all.
        return await this.reseedMetadata(doc);
      }
      const result: FolioResult = {
        docJobId: doc.docJobId,
        ark: doc.ark,
        ordre: last.ordre,
        lane,
        ok: last.ok,
      };
      await this.deps.queue.send(Q.monitor, result);
      return `${Q.monitor} (fan-in kick, all ${expected.length} folios already landed)`;
    }

    const items: FolioItem[] = missing.map((ordre) => ({
      docJobId: doc.docJobId,
      ark: doc.ark,
      ordre,
      kind: lane === "text" ? "alto" : "image",
      lane,
    }));
    await this.deps.queue.sendMany(Q.fetch, withFetchPriority(items));
    return `${Q.fetch} (${missing.length}/${expected.length} folios)`;
  }

  /** The image lanes' expected ordres, from the cached manifest; null if uncached. */
  private async canvasOrdres(ark: string, pagesExpected: number): Promise<number[] | null> {
    const manifest = await this.deps.blob.getJson<Manifest>(keys.manifest(ark));
    if (!manifest) return null;
    // `pagesExpected` was itself the length of the (already capped) canvas slice
    // ManifestStage fanned out, so the same prefix reproduces the same ordres.
    return manifest.canvases.slice(0, pagesExpected).map((c) => c.ordre);
  }

  /**
   * Re-send the lane message for a doc the Monitor already routed (the case the
   * requeue-stranded CLI has always handled, now on a timer). Rebuilt from the
   * persisted plan + the landed folios, so it is the same DocReady the Monitor
   * would have sent.
   */
  private async requeueLane(doc: DocRow): Promise<string> {
    if (!doc.lane || !doc.meta || doc.pagesExpected == null) {
      // A routed doc with no plan can't have a lane message rebuilt; the head of
      // the pipeline can rebuild the plan itself.
      return await this.reseedMetadata(doc);
    }
    const folios = await this.deps.docState.listOkFolios(doc.docJobId);
    const ready: DocReady = {
      projectId: doc.projectId,
      docJobId: doc.docJobId,
      ark: doc.ark,
      runId: doc.runId,
      lane: doc.lane,
      pagesExpected: doc.pagesExpected,
      meta: doc.meta,
      folios,
    };
    const target = LANE_QUEUE[doc.lane];
    await this.deps.queue.send(target, ready);
    return `${target} (${folios.length} folios)`;
  }
}
