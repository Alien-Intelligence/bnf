/**
 * Run-completion detector — the bridge between the pipeline's per-doc transitions
 * and the one terminal callback. Wired to the pipeline's `onOutcome` observability
 * hook (the existing seam — no monkey-patching of the stages): after each dispatched
 * outcome it asks "is this doc's run now fully terminal?" and, if so, fires the
 * terminal commit callback exactly once.
 *
 * Cheap by construction:
 *  - `emit` outcomes (the folio fan-out — by far the bulk) are ignored outright.
 *  - the per-outcome work is a single PK lookup (docState.get); the run-wide
 *    statusCounts only runs once a doc has actually reached a terminal status.
 *  - idempotency is the emitter's run-store latch, so concurrent checks are safe
 *    without per-run locking (only one claims + POSTs).
 */
import type { Logger, StageOutcome } from "../core/types.js";
import type { DocStateStore, DocStatus } from "../domain/doc-state.js";
import type { RunStore } from "../domain/run.js";
import type { TerminalEmitter } from "./progress-callback.js";

const TERMINAL: ReadonlySet<DocStatus> = new Set<DocStatus>([
  "done",
  "failed",
  "skipped",
  "excluded",
]);

function docJobIdOf(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "docJobId" in payload) {
    const v = (payload as { docJobId: unknown }).docJobId;
    return typeof v === "string" ? v : null;
  }
  return null;
}

export class CompletionMonitor {
  constructor(
    private readonly docState: DocStateStore,
    private readonly runStore: RunStore,
    private readonly emitter: TerminalEmitter,
    private readonly log: Logger,
  ) {}

  /**
   * Pipeline observability hook. Synchronous + fire-and-forget by contract
   * (`onOutcome` returns void); the async completion check runs detached and any
   * error is logged, never thrown back into the stage dispatch.
   */
  noteOutcome(e: { kind: StageOutcome<unknown>["kind"]; payload: unknown }): void {
    if (e.kind === "emit") return; // fan-out, never a terminal doc transition
    const docJobId = docJobIdOf(e.payload);
    if (!docJobId) return;
    void this.checkDoc(docJobId).catch((err) =>
      this.log.error("completion_check_failed", {
        docJobId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  private async checkDoc(docJobId: string): Promise<void> {
    const row = await this.docState.get(docJobId);
    if (!row || !row.runId) return;
    if (!TERMINAL.has(row.status)) return; // doc not terminal yet → run can't be done
    await this.checkRun(row.runId);
  }

  /**
   * Check whether a run is fully terminal and, if so, emit its terminal callback.
   * Also called directly by the ingress for a zero-doc (removal-only) run, which is
   * "complete" the moment it is created. Safe to call repeatedly — the emitter's
   * latch guarantees a single callback.
   */
  async checkRun(runId: string): Promise<void> {
    const run = await this.runStore.get(runId);
    if (!run || run.terminalEmitted || run.canceled) return;
    const counts = await this.docState.statusCounts({ runId });
    const terminal =
      counts.done + counts.failed + counts.skipped + counts.excluded;
    if (terminal < run.totalDocs) return; // still in flight
    await this.emitter.emit(run);
  }
}
