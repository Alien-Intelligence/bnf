/**
 * Monitor — the fan-in / scatter-gather join. The one stateful stage: it consumes
 * per-folio results, records them (idempotently) against the doc's counter, and
 * when a doc's folios are all in, applies the per-doc fail-ratio and routes the
 * doc to its lane queue. Routes EXACTLY ONCE via an atomic `claimRoute` even if a
 * folio result is redelivered after completion.
 *
 * Folio order: the doc's usable pages are `listOkFolios()` (sorted ordres) so
 * downstream citations stay folio-accurate.
 */
import { PipelineStage, type StageDeps } from "../core/stage.js";
import type { StageContext, StageOutcome } from "../core/types.js";
import type { DocStateStore } from "../domain/doc-state.js";
import { Q, type Lane } from "../domain/queues.js";
import type { DocReady, FolioResult } from "../domain/types.js";

const LANE_QUEUE: Record<Lane, string> = {
  text: Q.assemble,
  vision: Q.describe,
  mistral: Q.ocrSubmit,
};

export interface MonitorOpts {
  /** Fail the doc if failed/expected exceeds this (default 0.25). */
  failRatio?: number;
  /** Below this folio count the ratio is too noisy to act on (default 4). */
  floor?: number;
}

export class MonitorStage extends PipelineStage<FolioResult, never> {
  readonly name = "monitor";
  readonly inputQueue = Q.monitor;
  override readonly concurrency = 8;

  private readonly failRatio: number;
  private readonly floor: number;

  constructor(
    deps: StageDeps,
    private readonly docState: DocStateStore,
    opts: MonitorOpts = {},
  ) {
    super(deps);
    this.failRatio = opts.failRatio ?? 0.25;
    this.floor = opts.floor ?? 4;
  }

  async process(r: FolioResult, _ctx: StageContext): Promise<StageOutcome<never>> {
    const tally = await this.docState.recordFolio(r.docJobId, r.ordre, r.ok);
    if (!tally.complete) return { kind: "done" };

    // Doc complete — too many folios lost?
    const tooManyFailed =
      tally.expected >= this.floor && tally.failed / tally.expected > this.failRatio;
    if (tooManyFailed) {
      const won = await this.docState.claimRoute(r.docJobId, "failed", {
        error: `page-fail-ratio ${tally.failed}/${tally.expected} > ${this.failRatio}`,
      });
      if (won) {
        this.log.warn("doc_failed_fail_ratio", {
          docJobId: r.docJobId,
          failed: tally.failed,
          expected: tally.expected,
        });
      }
      return { kind: "done" };
    }

    // Route the completed doc exactly once.
    const won = await this.docState.claimRoute(r.docJobId, "ready");
    if (!won) return { kind: "done" }; // already routed by an earlier (or redelivered) result

    const row = await this.docState.get(r.docJobId);
    if (!row || !row.lane || !row.meta) {
      this.log.error("monitor_missing_plan", { docJobId: r.docJobId });
      return { kind: "fail", reason: "doc plan missing at fan-in", terminal: true };
    }
    const folios = await this.docState.listOkFolios(r.docJobId);
    const ready: DocReady = {
      projectId: row.projectId,
      docJobId: row.docJobId,
      ark: row.ark,
      lane: row.lane,
      pagesExpected: tally.expected,
      meta: row.meta,
      folios,
    };
    await this.queue.send(LANE_QUEUE[row.lane], ready);
    this.log.info("doc_ready", { docJobId: row.docJobId, lane: row.lane, folios: folios.length });
    return { kind: "done" };
  }
}
