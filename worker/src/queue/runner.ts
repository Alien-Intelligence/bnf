/**
 * DocumentIngestRunner — Track 2's heart.
 *
 * Given a `document_ingest_job` row id, it:
 *   1. Loads the row, bumps attempts, marks started.
 *   2. Calls Track 1 (DocPipeline.prepare).
 *   3. If SkipReason → marks skipped.
 *   4. If PreparedDoc → short-circuits on unchanged contentHash, otherwise
 *      pushes through Track 3 (ClusterSink.upsert) and marks done.
 *   5. On any error, records `failed` on the doc-job and the per-ARK state.
 *   6. Finalizes the parent ingest_job if all siblings are terminal.
 *
 * Retry semantics (Pass 2):
 *   - Permanent errors (PermanentBnfError, bad ARK, 404)      → mark failed.
 *   - Transient errors before the attempt budget is exhausted → RETHROW so
 *     pg-boss honors its retryLimit/retryDelay/retryBackoff config.
 *   - Transient errors on the final attempt                   → mark failed.
 *
 * "Transient" is anything the prepare layer flags TransientBnfError, plus
 * everything `isTransient()` recognizes (network errors, timeouts, generic
 * unknown errors). The bias is to retry: known-permanent errors must opt out
 * explicitly via PermanentBnfError.
 */

import { ingest } from "../env.js";
import { isTransient } from "../prepare/errors.js";
import type {
  ClusterSink,
  DocPipeline,
  PreparedDoc,
  SkipReason,
  UpsertResult,
} from "../types.js";
import type { Repo } from "./repo.js";
import type {
  DocumentIngestJobRow,
  DocumentIngestJobStatus,
} from "./types.js";

/**
 * Mirrors the pg-boss `retryLimit` configured on the doc-job queue. A doc-job
 * is allowed this many TOTAL attempts (one original delivery + retryLimit
 * retries); on the last one, transient errors get recorded as a terminal
 * failure instead of being rethrown. Reads the same env knob as the
 * orchestrator so the two never drift out of lockstep.
 */
const MAX_DOC_JOB_ATTEMPTS = ingest.retryLimit() + 1;

export type DatasetIdResolver = (projectId: string) => Promise<number>;

export type RunnerLogger = (
  event: string,
  details: Record<string, unknown>,
) => void;

/**
 * Called after each per-doc state transition. Used by the HTTP-facing worker
 * to emit aggregate progress callbacks to the app. Optional — pure pg-boss
 * sandbox runs leave it undefined.
 */
export type OnDocTransition = (ingestJobId: string) => Promise<void>;

const defaultLogger: RunnerLogger = (event, details) => {
  console.log(`[runner] ${event}`, JSON.stringify(details));
};

function isSkip(value: PreparedDoc | SkipReason): value is SkipReason {
  return (value as SkipReason).skip === true;
}

export class DocumentIngestRunner {
  constructor(
    private readonly docPipeline: DocPipeline,
    private readonly clusterSink: ClusterSink,
    private readonly resolveDatasetId: DatasetIdResolver,
    private readonly repo: Repo,
    private readonly log: RunnerLogger = defaultLogger,
    private readonly onTransition: OnDocTransition | undefined = undefined,
  ) {}

  private async notifyTransition(ingestJobId: string): Promise<void> {
    if (!this.onTransition) return;
    try {
      await this.onTransition(ingestJobId);
    } catch (err) {
      console.error("[runner] onTransition hook failed:", err);
    }
  }

  async run(docJobId: string): Promise<void> {
    const job = await this.repo.getDocJob(docJobId);
    if (!job) {
      this.log("doc_job_missing", { docJobId });
      return;
    }
    if (this.isTerminal(job.status)) {
      this.log("doc_job_already_terminal", {
        docJobId,
        status: job.status,
      });
      return;
    }

    await this.repo.markIngestJobRunning(job.ingestJobId);
    await this.repo.setDocJobStatus(job.id, "extracting", {
      bumpAttempts: true,
      markStarted: true,
    });
    this.log("doc_job_started", {
      docJobId: job.id,
      ark: job.ark,
      attempts: job.attempts + 1,
    });

    // `attempts` was just bumped by setDocJobStatus(..., bumpAttempts: true),
    // so the CURRENT attempt number is job.attempts + 1.
    const currentAttempt = job.attempts + 1;
    const isFinalAttempt = currentAttempt >= MAX_DOC_JOB_ATTEMPTS;

    try {
      const prepared = await this.docPipeline.prepare({
        projectId: job.projectId,
        ark: job.ark,
      });

      if (isSkip(prepared)) {
        await this.handleSkip(job, prepared);
        return;
      }

      await this.handlePrepared(job, prepared);
    } catch (err) {
      // Transient errors should let pg-boss back off and retry the whole
      // doc-job — but ONLY until we've burned through the configured attempt
      // budget. On the final attempt we still record a terminal failure so
      // the doc-job doesn't loop forever.
      //
      // Permanent errors (bad ARK, 404, etc.) always go terminal: no amount
      // of retrying changes the outcome.
      if (isTransient(err) && !isFinalAttempt) {
        const message = err instanceof Error ? err.message : String(err);
        this.log("doc_job_transient_retry", {
          docJobId: job.id,
          ark: job.ark,
          attempt: currentAttempt,
          maxAttempts: MAX_DOC_JOB_ATTEMPTS,
          error: message,
        });
        // Record `awaiting_retry` so anyone querying the table mid-flight
        // sees the truth: the doc is parked in pg-boss waiting to be
        // re-delivered, not actively `extracting`. The next attempt will
        // transition it back through extracting → indexing → done.
        await this.repo
          .setDocJobStatus(job.id, "awaiting_retry", { error: message })
          .catch((dbErr) => {
            // If we can't even update the row, log and continue — the
            // retry still happens; the row stays in `extracting`, which
            // is misleading but not destructive.
            console.error(
              "[runner] failed to record awaiting_retry status:",
              dbErr,
            );
          });
        throw err;
      }
      await this.handleFailure(job, err);
    } finally {
      await this.finalizeParent(job.ingestJobId);
    }
  }

  // -------------------------------------------------------------------------
  // Branches
  // -------------------------------------------------------------------------

  private async handleSkip(
    job: DocumentIngestJobRow,
    skip: SkipReason,
  ): Promise<void> {
    const reason = skip.reason;
    this.log("doc_job_skipped", { docJobId: job.id, ark: job.ark, reason });
    await this.repo.setDocJobStatus(job.id, "skipped", {
      skipReason: reason,
      markFinished: true,
    });
    await this.repo.upsertDocState({
      projectId: job.projectId,
      ark: job.ark,
      status: "skipped",
      lastJobId: job.id,
      lastError: reason,
    });
    await this.repo.bumpIngestJobCounters(job.ingestJobId, { skipped: 1 });
  }

  private async handlePrepared(
    job: DocumentIngestJobRow,
    prepared: PreparedDoc,
  ): Promise<void> {
    // Content-hash short-circuit. We must call prepare() first because the
    // hash is derived from the canonical doc.json — see PreparedDoc.contentHash.
    const existing = await this.repo.getDocState(job.projectId, job.ark);
    if (
      existing &&
      existing.status === "ingested" &&
      existing.contentHash === prepared.contentHash &&
      existing.entryId != null
    ) {
      this.log("doc_job_short_circuit", {
        docJobId: job.id,
        ark: job.ark,
        contentHash: prepared.contentHash,
        entryId: existing.entryId,
      });
      await this.repo.setDocJobStatus(job.id, "done", {
        pipeline: prepared.pipeline,
        contentHash: prepared.contentHash,
        entryId: existing.entryId,
        chunksWritten: existing.chunksWritten,
        markFinished: true,
      });
      await this.repo.upsertDocState({
        projectId: job.projectId,
        ark: job.ark,
        status: "ingested",
        pipeline: prepared.pipeline,
        contentHash: prepared.contentHash,
        lastJobId: job.id,
        entryId: existing.entryId,
        chunksWritten: existing.chunksWritten,
        lastError: null,
      });
      await this.repo.bumpIngestJobCounters(job.ingestJobId, { done: 1 });
      return;
    }

    // Reflect the real sub-stages (embedding → indexing) so corpus-level
    // progress shows a genuine staircase instead of one atomic "indexing"
    // lump. The cluster sink fires onStage as it crosses each boundary.
    const onStage = async (stage: "embedding" | "indexing"): Promise<void> => {
      await this.repo.setDocJobStatus(job.id, stage, {
        pipeline: prepared.pipeline,
        contentHash: prepared.contentHash,
      });
      this.log(`doc_job_${stage}`, {
        docJobId: job.id,
        ark: job.ark,
        pipeline: prepared.pipeline,
        chunkCount: prepared.chunks.length,
      });
      await this.notifyTransition(job.ingestJobId);
    };

    const datasetId = await this.resolveDatasetId(job.projectId);
    const result: UpsertResult = await this.clusterSink.upsert({
      datasetId,
      prepared,
      onStage,
    });

    await this.repo.setDocJobStatus(job.id, "done", {
      pipeline: prepared.pipeline,
      contentHash: prepared.contentHash,
      entryId: result.entryId,
      chunksWritten: result.chunksWritten,
      markFinished: true,
    });
    await this.repo.upsertDocState({
      projectId: job.projectId,
      ark: job.ark,
      status: "ingested",
      pipeline: prepared.pipeline,
      contentHash: prepared.contentHash,
      lastJobId: job.id,
      entryId: result.entryId,
      chunksWritten: result.chunksWritten,
      lastError: null,
    });
    await this.repo.bumpIngestJobCounters(job.ingestJobId, {
      done: 1,
      chunks: result.chunksWritten,
    });
    this.log("doc_job_done", {
      docJobId: job.id,
      ark: job.ark,
      entryId: result.entryId,
      chunksWritten: result.chunksWritten,
    });
  }

  private async handleFailure(
    job: DocumentIngestJobRow,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.log("doc_job_failed", {
      docJobId: job.id,
      ark: job.ark,
      error: message,
    });
    await this.repo
      .setDocJobStatus(job.id, "failed", {
        error: message,
        markFinished: true,
      })
      .catch((dbErr) => {
        // Swallowing here would mask the failure — re-throw is also wrong
        // because we're in the catch path. Log and rely on the next attempt
        // surface to retry. If DB is dead the runner can't record anything
        // anyway.
        console.error("[runner] failed to record doc-job failure:", dbErr);
      });
    await this.repo
      .upsertDocState({
        projectId: job.projectId,
        ark: job.ark,
        status: "failed",
        lastJobId: job.id,
        lastError: message,
      })
      .catch((dbErr) => {
        console.error("[runner] failed to record doc-state failure:", dbErr);
      });
    await this.repo
      .bumpIngestJobCounters(job.ingestJobId, { failed: 1 })
      .catch((dbErr) => {
        console.error("[runner] failed to bump parent failure counter:", dbErr);
      });
  }

  private async finalizeParent(ingestJobId: string): Promise<void> {
    try {
      const newStatus = await this.repo.finalizeIngestJobIfAllTerminal(
        ingestJobId,
      );
      if (newStatus) {
        this.log("ingest_job_finalized", {
          ingestJobId,
          status: newStatus,
        });
      }
    } catch (err) {
      console.error("[runner] finalizeParent failed:", err);
    }
    // Notify after every doc transition (terminal or stage). Hook is
    // responsible for coalescing repeated calls.
    await this.notifyTransition(ingestJobId);
  }

  private isTerminal(status: DocumentIngestJobStatus): boolean {
    return status === "done" || status === "failed" || status === "skipped";
  }
}
