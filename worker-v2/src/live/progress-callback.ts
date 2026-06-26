/**
 * Terminal commit callback — v2's ONE outbound wire to the app. On run completion
 * it computes the terminal ClusterProgressEvent from v2's own status counts,
 * HMAC-signs it with the run's per-job secret, and POSTs it to the app's callback
 * URL. That terminal event is the app's version-commit trigger (IngestService.
 * applyProgress → commit / commitPartialFailure).
 *
 * Self-contained (the dual-undici lesson): the HMAC is node:crypto, the POST is
 * the global fetch — no app imports, no shared client. The signing convention
 * mirrors the app's verifier byte-for-byte: header `x-callback-signature`, value
 * `sha256=<hex>` over the EXACT request body bytes (see Phase 0 wire doc).
 *
 * Idempotency: the run-store latch (markTerminalEmitted) lets exactly one caller
 * win the emit; a failed POST releases the latch so a later completion check
 * retries. The app's applyProgress is itself idempotent (a redelivered terminal
 * overwrites), so a rare double-fire is harmless.
 */
import crypto from "node:crypto";

import type { Logger } from "../core/types.js";
import type { DocStateStore, FailedDoc } from "../domain/doc-state.js";
import type { DocStatus } from "../domain/doc-state.js";
import type { IngestRun, RunStore } from "../domain/run.js";

/** The app's `stats` shape that applyProgress / commitPartialFailure / retryFailed read. */
export interface TerminalStats {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  /** ONE entry per failed doc — drives per-ark indexError + the retry list. */
  errors: Array<{ ark: string; stage: string; reason: string }>;
}

/** The terminal ClusterProgressEvent (the app contract's two terminal variants). */
export type TerminalEvent =
  | { stage: "done"; chunksWritten: number; stats: TerminalStats }
  | { stage: "failed"; error: string; partialStats: TerminalStats };

/** HMAC-SHA256 signature of the body, `sha256=<hex>` — mirrors the app verifier. */
export function signBody(body: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Build the terminal event from the run's doc-status counts + its failed docs.
 *
 * Rule (matches applyProgress, see Phase 0): a run with ANY success — or no hard
 * failures — emits `done` (the app advances the version pointer; partial failures
 * are reconciled per-ark from `errors[]`). A run where EVERY ingestable doc failed
 * (zero done, ≥1 failed) emits `failed` so the app leaves the pointer behind.
 *
 * `skipped`/`excluded` go to `stats.skipped`, never `errors[]`: they are
 * non-ingestable, so the app marks them indexed (they drop from the delta) instead
 * of retrying ARKs that can never succeed.
 */
export function buildTerminalEvent(input: {
  totalDocs: number;
  counts: Record<DocStatus, number>;
  failedDocs: FailedDoc[];
  chunksWritten: number;
}): TerminalEvent {
  const { counts, failedDocs, chunksWritten } = input;
  const done = counts.done;
  const failed = counts.failed;
  const skipped = counts.skipped + counts.excluded;
  const errors = failedDocs.map((d) => ({
    ark: d.ark,
    stage: d.lane ?? "unknown",
    reason: d.error ?? "échec",
  }));
  const stats: TerminalStats = {
    total: input.totalDocs,
    done,
    failed,
    skipped,
    errors,
  };

  if (done > 0 || failed === 0) {
    return { stage: "done", chunksWritten, stats };
  }
  return {
    stage: "failed",
    error: `tous les documents ont échoué (${failed}/${input.totalDocs})`,
    partialStats: stats,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface TerminalEmitterOpts {
  /** Total POST attempts before giving up (default 4). */
  maxAttempts?: number;
  /** Base backoff in ms (exponential: base * 2^(attempt-1)) (default 500). */
  backoffMs?: number;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
}

export class TerminalEmitter {
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly docState: DocStateStore,
    private readonly runStore: RunStore,
    private readonly log: Logger,
    opts: TerminalEmitterOpts = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.backoffMs = opts.backoffMs ?? 500;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /**
   * Emit the terminal event for a completed run. Returns true iff THIS call sent
   * it (won the latch and the POST succeeded). A non-winning call (already
   * emitted / canceled) returns false. A POST that fails after all attempts
   * releases the latch and throws — the caller logs and a later check retries.
   */
  async emit(run: IngestRun): Promise<boolean> {
    const counts = await this.docState.statusCounts({ runId: run.runId });
    const failedDocs = await this.docState.listFailedDocs(run.runId);
    const chunksWritten = await this.docState.donePageCount(run.runId);
    const event = buildTerminalEvent({
      totalDocs: run.totalDocs,
      counts,
      failedDocs,
      chunksWritten,
    });

    const claimed = await this.runStore.markTerminalEmitted(run.runId);
    if (!claimed) {
      this.log.info("terminal_emit_skipped", { runId: run.runId, reason: "not_claimed" });
      return false;
    }

    try {
      await this.post(run.callbackUrl, run.callbackSecret, event);
      this.log.info("terminal_emitted", {
        runId: run.runId,
        appJobId: run.appJobId,
        stage: event.stage,
        done: counts.done,
        failed: counts.failed,
        skipped: counts.skipped + counts.excluded,
      });
      return true;
    } catch (e) {
      await this.runStore.resetTerminalEmitted(run.runId);
      this.log.error("terminal_emit_failed", {
        runId: run.runId,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  private async post(url: string, secret: string, event: TerminalEvent): Promise<void> {
    const body = JSON.stringify(event);
    const signature = signBody(body, secret);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await this.fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-callback-signature": signature,
          },
          body,
        });
        if (res.ok) return;
        lastErr = new Error(`callback returned ${res.status} ${res.statusText}`);
      } catch (e) {
        lastErr = e;
      }
      if (attempt < this.maxAttempts) {
        await sleep(this.backoffMs * 2 ** (attempt - 1));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
