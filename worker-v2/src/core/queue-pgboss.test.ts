/**
 * PgBossQueue against a real pg-boss (`npm run test:pg`, WORKER_TEST_DATABASE_URL
 * — RUN.md). What a MemoryQueue cannot prove:
 *
 *  - a delivery handed back at shutdown keeps its attempt history across a
 *    RESTART (a new PgBossQueue on the same database): the copy is delivered
 *    as the attempt it was, its retry budget is what was left, and
 *    `onExhausted` fires after the real number of attempts (pass-5 item 10:
 *    the copy used to start again at retry_count 0).
 *
 * Each case uses its own queue name and deletes the queue afterwards.
 * Without the URL the suite is reported SKIPPED, never silently passed.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";

import { pgPoolConfig } from "../config.js";
import { shutdownWorker } from "../shutdown.js";
import { MemoryBlobStore } from "./blob.js";
import { createMemoryLogger } from "./logger.js";
import { ATTEMPTS_SPENT_KEY } from "./queue-attempts.js";
import { PgBossQueue } from "./queue-pgboss.js";
import { RateLimiter } from "./rate.js";
import { PipelineStage, type StageDeps } from "./stage.js";
import type { RateGate, StageContext, StageOutcome } from "./types.js";

const PG_URL = process.env.WORKER_TEST_DATABASE_URL;
if (process.env.WORKER_TEST_REQUIRE_PG === "1" && !PG_URL) {
  throw new Error("npm run test:pg needs WORKER_TEST_DATABASE_URL (RUN.md)");
}
const pool = PG_URL ? new Pool(pgPoolConfig(PG_URL)) : null;
const queues: string[] = [];

function freshQueue(label: string): string {
  const name = `zz-test-${label}-${randomBytes(4).toString("hex")}`;
  queues.push(name);
  return name;
}

after(async () => {
  if (!pool) return;
  for (const name of queues) {
    // pg-boss's delete_queue drops the partition only once it holds no job.
    await pool.query("DELETE FROM pgboss.job WHERE name = $1", [name]);
    await pool.query("SELECT pgboss.delete_queue($1)", [name]);
  }
  await pool.end();
});

async function until(what: string, check: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Always fails (non-terminal); records the attempts it saw and when it was exhausted. */
class FlakyStage extends PipelineStage<{ ark: string }, never> {
  readonly name = "flaky";
  readonly concurrency = 1;
  override readonly retry = { attempts: 3, baseMs: 1, maxDelayMs: 1 };
  override readonly queueRetryDelayMs = 1_000;
  readonly attemptsSeen: number[] = [];
  readonly exhaustedAt: number[] = [];
  constructor(
    deps: StageDeps,
    readonly inputQueue: string,
    readonly rate: RateGate,
  ) {
    super(deps);
  }
  async process(_item: { ark: string }, ctx: StageContext): Promise<StageOutcome<never>> {
    this.attemptsSeen.push(ctx.attempt);
    return { kind: "fail", reason: "transient" };
  }
  protected override async onExhausted(): Promise<void> {
    this.exhaustedAt.push(this.attemptsSeen.at(-1) ?? 0);
  }
}

describe("PgBossQueue on a real pg-boss", { skip: pool ? undefined : "WORKER_TEST_DATABASE_URL is not set" }, () => {
  test("item 10: a hand-back keeps retry history across a restart; onExhausted fires at the real last attempt", async () => {
    if (!pool || !PG_URL) throw new Error("unreachable: skipped without a database");
    const name = freshQueue("handback");
    const { logger, lines } = createMemoryLogger();

    // --- process 1: attempt 1 fails, attempt 2 waits on a spent gate, SIGTERM.
    const first = new PgBossQueue(pgPoolConfig(PG_URL));
    await first.start();
    const gate = new RateLimiter({ ratePerMin: 1, burst: 1 });
    const stage1 = new FlakyStage({ queue: first, blob: new MemoryBlobStore(), log: logger }, name, gate);
    await stage1.start();
    await first.send(name, { ark: "ark:/12148/h" });
    await until("attempt 2 to wait on the gate", async () => {
      const { rows } = await pool.query<{ state: string; retry_count: number }>(
        "SELECT state, retry_count FROM pgboss.job WHERE name = $1",
        [name],
      );
      return rows.length === 1 && rows[0]?.state === "active" && rows[0].retry_count === 1;
    });
    assert.deepEqual(stage1.attemptsSeen, [1]);
    await shutdownWorker(
      {
        log: logger,
        stopIntake: async () => {},
        pipeline: { drain: (ms) => first.drain(ms), stop: () => first.stop() },
        gates: [gate],
        closePools: async () => {},
      },
      { drainMs: 200, handBackMs: 5_000 },
    );
    assert.ok(lines.some((l) => l.event === "delivery_handed_back"));

    const { rows: copies } = await pool.query<{ retry_limit: number; retry_count: number; data: Record<string, unknown> }>(
      "SELECT retry_limit, retry_count, data FROM pgboss.job WHERE name = $1 AND state = 'created'",
      [name],
    );
    assert.equal(copies.length, 1, "one copy waits for the next process");
    assert.equal(copies[0]?.retry_limit, 1, "3 attempts allowed, 1 spent, this copy's first delivery is attempt 2 → 1 retry left");
    assert.equal(copies[0]?.data[ATTEMPTS_SPENT_KEY], 1);

    // --- process 2 (the restart): attempts 2 and 3, then exhausted.
    const second = new PgBossQueue(pgPoolConfig(PG_URL));
    await second.start();
    const open = new RateLimiter({ ratePerMin: 6_000, burst: 10 });
    try {
      const stage2 = new FlakyStage({ queue: second, blob: new MemoryBlobStore(), log: logger }, name, open);
      await stage2.start();
      await until("the copy to fail terminally", async () => {
        const { rows } = await pool.query<{ state: string }>(
          "SELECT state FROM pgboss.job WHERE name = $1 AND state NOT IN ('completed')",
          [name],
        );
        return rows.length === 1 && rows[0]?.state === "failed";
      });
      assert.deepEqual(stage2.attemptsSeen, [2, 3], "the history continues where it stopped");
      assert.deepEqual(stage2.exhaustedAt, [3], "onExhausted fired once, on the real last attempt");
    } finally {
      open.stop();
      await second.stop();
    }
  });
});
