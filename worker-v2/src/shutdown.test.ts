/**
 * The shutdown order, driven exactly as main.ts drives it (shutdownWorker),
 * against a queue whose `send` THROWS once stopped — the property pg-boss has
 * and a plain MemoryQueue lacks. A delivery waiting on a rate gate when
 * shutdown starts must be handed back (re-sent before the transport closes):
 * no failure, no attempt counted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryBlobStore } from "./core/blob.js";
import { createMemoryLogger } from "./core/logger.js";
import { MemoryQueue } from "./core/queue-memory.js";
import { RateLimiter } from "./core/rate.js";
import { PipelineStage, type StageDeps } from "./core/stage.js";
import type { RateGate, StageContext, StageOutcome } from "./core/types.js";
import { shutdownWorker } from "./shutdown.js";

const IN_Q = "shutdown-in";

/** A MemoryQueue whose `send` fails after stop(), like pg-boss once closed. */
class ClosingQueue extends MemoryQueue {
  closed = false;
  readonly sentAfterStart: unknown[] = [];
  started = false;
  override async send<T>(queue: string, payload: T, opts?: { startAfterMs?: number }): Promise<void> {
    if (this.closed) throw new Error("PgBossQueue not started");
    if (this.started) this.sentAfterStart.push(payload);
    return super.send(queue, payload, opts);
  }
  override async stop(): Promise<void> {
    await super.stop();
    this.closed = true;
  }
}

class GatedStage extends PipelineStage<{ ark: string }, never> {
  readonly name = "gated";
  readonly inputQueue = IN_Q;
  readonly concurrency = 1;
  processed = 0;
  constructor(
    deps: StageDeps,
    readonly rate: RateGate,
  ) {
    super(deps);
  }
  async process(_item: { ark: string }, _ctx: StageContext): Promise<StageOutcome<never>> {
    this.processed += 1;
    return { kind: "done" };
  }
}

test("shutdown in main.ts order: a delivery stuck on a gate is handed back before the transport closes", async () => {
  const queue = new ClosingQueue();
  const { logger, lines } = createMemoryLogger();
  // One token, already spent: the delivery waits on the gate (~60 s) when shutdown starts.
  const gate = new RateLimiter({ ratePerMin: 1, burst: 1 });
  await gate.acquire(new AbortController().signal);
  const stage = new GatedStage({ queue, blob: new MemoryBlobStore(), log: logger }, gate);
  await stage.start();
  await queue.send(IN_Q, { ark: "ark:/12148/a" });
  queue.started = true;
  await new Promise((r) => setTimeout(r, 20)); // the delivery is now waiting on the gate

  await shutdownWorker(
    {
      log: logger,
      stopIntake: async () => {},
      pipeline: { drain: (ms) => queue.drain(ms), stop: () => queue.stop() },
      gates: [gate],
      closePools: async () => {},
    },
    { drainMs: 50, handBackMs: 1_000 },
  );

  assert.ok(lines.some((l) => l.event === "delivery_handed_back"), "the delivery was handed back");
  assert.deepEqual(queue.sentAfterStart, [{ ark: "ark:/12148/a" }], "re-sent while the transport was alive");
  assert.equal(stage.processed, 0, "no work ran ungated");
  const counts = await queue.counts(IN_Q);
  assert.equal(counts.failed, 0, "no failure — no attempt counted");
});
