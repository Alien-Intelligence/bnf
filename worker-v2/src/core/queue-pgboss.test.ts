/**
 * PgBossQueue against a real pg-boss (`npm run test:pg`, WORKER_TEST_DATABASE_URL
 * — RUN.md). What a MemoryQueue cannot prove:
 *
 *  - a job sent BEFORE its consumer's `work()` (a producer stage starts
 *    first) carries the declared policy on the JOB row and the queue row —
 *    never pg-boss's retry_limit 2 / 15-min expiry (pass-6 item 9); a send
 *    to an undeclared queue throws (pass-6 items 7-9);
 *  - a delivery handed back at shutdown keeps its attempt history across a
 *    RESTART (a new PgBossQueue on the same database): the copy is sent with
 *    the budget that was left, delivered as the attempt it was, and
 *    `onExhausted` fires after the real number of attempts (pass-5 item 10);
 *  - the attempt comes from the job row alone: a payload that happens to
 *    carry any field is delivered as is, attempt 1 (pass-6 item 6).
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
    // A queue a case never created (the undeclared send) has no row to drop.
    await pool.query("SELECT pgboss.delete_queue(name) FROM pgboss.queue WHERE name = $1", [name]);
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
  test("items 9/11: a job sent BEFORE work() carries the declared policy on its JOB row and the queue row", async () => {
    if (!pool || !PG_URL) throw new Error("unreachable: skipped without a database");
    const queue = new PgBossQueue(pgPoolConfig(PG_URL));
    await queue.start();
    try {
      const name = freshQueue("policy");
      queue.declare(name, { retryLimit: 5, expireInSeconds: 77, retryDelayMs: 3_000 });
      await queue.send(name, { ark: "ark:/12148/p" }); // no consumer yet
      await queue.sendMany(name, [{ ark: "ark:/12148/q" }]);
      const jobs = await pool.query<{ retry_limit: number; expire_s: number; retry_delay: number }>(
        "SELECT retry_limit, extract(epoch FROM expire_in)::int AS expire_s, retry_delay FROM pgboss.job WHERE name = $1",
        [name],
      );
      assert.deepEqual(jobs.rows, [
        { retry_limit: 5, expire_s: 77, retry_delay: 3 },
        { retry_limit: 5, expire_s: 77, retry_delay: 3 },
      ]);
      await queue.work(name, async () => {}, { concurrency: 1, retryLimit: 5, expireInSeconds: 77, retryDelayMs: 3_000 });
      const { rows } = await pool.query<{ retry_limit: number; expire_seconds: number }>(
        "SELECT retry_limit, expire_seconds FROM pgboss.queue WHERE name = $1",
        [name],
      );
      assert.deepEqual(rows, [{ retry_limit: 5, expire_seconds: 77 }]);
    } finally {
      await queue.stop();
    }
  });

  test("items 7-9: a send to a queue nobody declared throws instead of using pg-boss's defaults", async () => {
    if (!PG_URL) throw new Error("unreachable: skipped without a database");
    const queue = new PgBossQueue(pgPoolConfig(PG_URL));
    await queue.start();
    try {
      await assert.rejects(queue.send(freshQueue("undeclared"), { ark: "x" }), /no declared policy/);
    } finally {
      await queue.stop();
    }
  });

  test("item 6: the attempt comes from the job row — payload fields named like anything are inert", async () => {
    if (!pool || !PG_URL) throw new Error("unreachable: skipped without a database");
    const queue = new PgBossQueue(pgPoolConfig(PG_URL));
    await queue.start();
    try {
      const name = freshQueue("inert");
      const seen: Array<{ attempts: number; payload: unknown }> = [];
      await queue.work<Record<string, unknown>>(
        name,
        async (msg) => {
          seen.push({ attempts: msg.attempts, payload: msg.payload });
        },
        { concurrency: 2, retryLimit: 2 },
      );
      await queue.send(name, { ark: "a", __attemptsSpent: 5 });
      await queue.send(name, { ark: "b", __attemptsSpent: "x" });
      await until("both delivered", async () => seen.length === 2);
      assert.deepEqual(
        [...seen].sort((x, y) => JSON.stringify(x.payload).localeCompare(JSON.stringify(y.payload))),
        [
          { attempts: 1, payload: { ark: "a", __attemptsSpent: 5 } },
          { attempts: 1, payload: { ark: "b", __attemptsSpent: "x" } },
        ],
      );
    } finally {
      await queue.stop();
    }
  });

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

    const { rows: copies } = await pool.query<{ retry_limit: number; data: Record<string, unknown> }>(
      "SELECT retry_limit, data FROM pgboss.job WHERE name = $1 AND state = 'created'",
      [name],
    );
    assert.equal(copies.length, 1, "one copy waits for the next process");
    assert.equal(copies[0]?.retry_limit, 1, "3 attempts allowed, 1 spent → the copy keeps 1 retry");
    assert.deepEqual(copies[0]?.data, { ark: "ark:/12148/h" }, "the payload is untouched");

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
