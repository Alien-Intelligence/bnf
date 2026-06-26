/**
 * Pipeline runner — the thin composition root. It owns nothing clever: it holds
 * the queue transport + the list of stages, starts every stage's worker loop, and
 * seeds the head queue with documents to ingest. All the behaviour lives in the
 * stages and the base class; the runner just wires them and provides start/stop.
 *
 * A stage only needs to expose `name` + `start()` to be run here (the base class
 * satisfies that), so the runner stays decoupled from each stage's In/Out types —
 * data flow between stages is via the queues, not via the runner.
 */
import { Q } from "../domain/queues.js";
import type { DocRef } from "../domain/types.js";
import type { Logger, QueueClient } from "./types.js";

/** The minimal surface the runner needs from a stage (PipelineStage satisfies it). */
export interface RunnableStage {
  readonly name: string;
  readonly inputQueue: string;
  start(): Promise<void>;
}

export class Pipeline {
  private started = false;

  constructor(
    private readonly queue: QueueClient,
    private readonly stages: readonly RunnableStage[],
    private readonly log: Logger,
  ) {
    const seen = new Set<string>();
    for (const s of stages) {
      if (seen.has(s.inputQueue)) {
        throw new Error(`pipeline: two stages bound to the same input queue ${s.inputQueue}`);
      }
      seen.add(s.inputQueue);
    }
  }

  /** Start every stage's worker loop. Idempotent guard so a double-start throws. */
  async start(): Promise<void> {
    if (this.started) throw new Error("pipeline already started");
    this.started = true;
    for (const s of this.stages) {
      await s.start();
    }
    this.log.info("pipeline_started", { stages: this.stages.map((s) => s.name) });
  }

  /** Seed the head of the pipeline with documents to ingest (enters the metadata stage). */
  async seed(docs: readonly DocRef[]): Promise<void> {
    if (docs.length === 0) return;
    await this.queue.sendMany(Q.metadata, docs);
    this.log.info("pipeline_seeded", { count: docs.length });
  }

  async stop(): Promise<void> {
    await this.queue.stop();
    this.started = false;
    this.log.info("pipeline_stopped", {});
  }
}
