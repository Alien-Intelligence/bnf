/**
 * The worker's shutdown sequence (SIGTERM/SIGINT, main.ts), in the one order
 * that lets an in-flight delivery be HANDED BACK instead of failing:
 *
 *   1. stop the sweeps and the HTTP ingress (no new work enters);
 *   2. drain — stop fetching and wait for in-flight handlers, with the queue
 *      transport ALIVE (QueueClient.drain);
 *   3. stop the rate gates — a handler still waiting on one gets
 *      RateGateStoppedError and the stage base hands its delivery back through
 *      `send`, which still works because the transport is alive;
 *   4. give those hand-backs a short budget to land;
 *   5. only then close the transport (pg-boss) and the pools.
 *
 * A handler still running after step 5 leaves its job `active`; pg-boss
 * expires it (queue-pgboss.ts settle()).
 */
import type { Logger } from "./core/types.js";

/** The parts shutdown acts on — what main.ts built. */
export interface ShutdownParts {
  log: Logger;
  /** Step 1: the work sources (reconciliation sweep, HTTP server). */
  stopIntake(): Promise<void>;
  pipeline: { drain(budgetMs: number): Promise<number>; stop(): Promise<void> };
  gates: ReadonlyArray<{ stop(): void }>;
  /** Pools that outlive the transport (the doc-state pool). */
  closePools(): Promise<void>;
}

export interface ShutdownBudgets {
  /** Step 2 — inside the pod's 120 s terminationGracePeriodSeconds. */
  drainMs: number;
  /** Step 4 — hand-backs are one `send` each. */
  handBackMs: number;
}

/** 100 s of drain + 5 s of hand-backs + the closes fit the pod's 120 s grace. */
export const SHUTDOWN_BUDGETS: ShutdownBudgets = { drainMs: 100_000, handBackMs: 5_000 };

export async function shutdownWorker(parts: ShutdownParts, budgets: ShutdownBudgets): Promise<void> {
  const { log } = parts;
  await parts.stopIntake();
  const stillRunning = await parts.pipeline.drain(budgets.drainMs);
  for (const gate of parts.gates) gate.stop();
  if (stillRunning > 0) {
    const left = await parts.pipeline.drain(budgets.handBackMs);
    log.info("shutdown_hand_back_window", { inFlightBefore: stillRunning, inFlightAfter: left });
  }
  await parts.pipeline.stop();
  await parts.closePools();
}
