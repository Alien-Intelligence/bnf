/**
 * IngestOrchestrator — submit-side. The caller hands us a project id and the
 * exact list of ARKs to ingest; we create the parent + child rows, then
 * bulk-enqueue one pg-boss job per child.
 *
 * Corpus-delta computation (which ARKs are added vs removed for this version)
 * is OUT OF SCOPE for this sandbox — that lives in the real backend.
 */

import type PgBoss from "pg-boss";
import { ingest } from "../env.js";
import type { Repo } from "./repo.js";
import {
  DOC_QUEUE_NAME,
  type DocJobQueuePayload,
  type DocumentIngestJobRow,
  type IngestJobRow,
} from "./types.js";

export interface SubmitInput {
  projectId: string;
  arks: string[];
}

export interface SubmitResult {
  ingestJobId: string;
  documentIngestJobIds: string[];
}

export interface IngestOrchestratorOptions {
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  /** Per-doc-job wall-clock ceiling. Long OCR books at 5 req/min need hours. */
  expireInSeconds?: number;
}

export class IngestOrchestrator {
  private readonly opts: Required<IngestOrchestratorOptions>;

  constructor(
    private readonly repo: Repo,
    private readonly boss: PgBoss,
    opts: IngestOrchestratorOptions = {},
  ) {
    // Defaults come from the env `ingest` slice so the runner's attempt budget
    // (MAX_DOC_JOB_ATTEMPTS) and the queue's retry policy stay in lockstep.
    this.opts = {
      retryLimit: ingest.retryLimit(),
      retryDelay: ingest.retryDelaySeconds(),
      retryBackoff: true,
      expireInSeconds: ingest.jobExpireSeconds(),
      ...opts,
    };
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    if (input.arks.length === 0) {
      throw new Error("IngestOrchestrator.submit: arks must not be empty");
    }
    // De-dup within this single submission. Cross-submission de-dup is a
    // known limitation (see README of Track 2 work).
    const arks = Array.from(new Set(input.arks));

    const { parent, children } = await this.repo.tx(async (client) => {
      const parent: IngestJobRow = await this.repo.createIngestJob(
        { projectId: input.projectId, totalDocs: arks.length },
        client,
      );
      const children: DocumentIngestJobRow[] = await this.repo.createDocJobs(
        { ingestJobId: parent.id, projectId: input.projectId, arks },
        client,
      );
      return { parent, children };
    });

    await this.boss.createQueue(DOC_QUEUE_NAME).catch(() => {
      // pg-boss v10 requires queues to exist; createQueue is idempotent in
      // practice but may throw on a race. Safe to swallow.
    });

    // Submit-side jitter: spread N jobs uniformly in [0, N*0.4] seconds so a
    // 15-doc submission doesn't simultaneously light up 15 OAIRecord +
    // Pagination calls. The global Gallica token bucket would absorb the
    // burst eventually, but spreading at insert time means workers come
    // online staggered rather than all parking on `acquire()` at t=0.
    const jitterCeilingMs = children.length * 0.4 * 1000;
    const now = Date.now();
    const jobs = children.map((child) => ({
      name: DOC_QUEUE_NAME,
      data: { docJobId: child.id } satisfies DocJobQueuePayload,
      retryLimit: this.opts.retryLimit,
      retryDelay: this.opts.retryDelay,
      retryBackoff: this.opts.retryBackoff,
      // Without this, pg-boss force-expires any doc-job running longer than its
      // default (15 min) and re-queues it — a long OCR book at 5 req/min would
      // never finish, it would expire-loop until retries exhaust. Give it hours.
      expireInSeconds: this.opts.expireInSeconds,
      // pg-boss insert accepts startAfter as Date | string only.
      startAfter: new Date(now + Math.floor(Math.random() * jitterCeilingMs)),
    }));
    await this.boss.insert(jobs);

    return {
      ingestJobId: parent.id,
      documentIngestJobIds: children.map((c) => c.id),
    };
  }
}
