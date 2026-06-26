/**
 * Unit tests for the in-memory queue (core/queue-memory.ts).
 *
 * MemoryQueue models at-least-once delivery with bounded concurrency,
 * retry-on-throw (up to retryLimit), and an idle() test helper. These tests
 * exercise delivery, the concurrency cap, the retry/terminal policy, attempt
 * counting, idle settling, and counts() reconciliation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryQueue } from "./queue-memory.js";
import type { QueueMessage } from "./types.js";

/** A promise that can be resolved from the outside — used to gate handlers. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("send + work: handler receives the payload and the message completes", async () => {
  const q = new MemoryQueue();
  const seen: unknown[] = [];

  await q.work<{ v: number }>(
    "jobs",
    async (msg) => {
      seen.push(msg.payload);
    },
    { concurrency: 1 },
  );

  await q.send("jobs", { v: 42 });
  await q.idle();

  assert.deepEqual(seen, [{ v: 42 }]);
  const counts = await q.counts("jobs");
  assert.equal(counts.completed, 1);
  assert.equal(counts.queued, 0);
  assert.equal(counts.running, 0);
  assert.equal(counts.failed, 0);
});

test("sendMany: every payload is delivered", async () => {
  const q = new MemoryQueue();
  const seen: number[] = [];

  await q.work<number>(
    "batch",
    async (msg) => {
      seen.push(msg.payload);
    },
    { concurrency: 3 },
  );

  const payloads = [1, 2, 3, 4, 5];
  await q.sendMany("batch", payloads);
  await q.idle();

  assert.deepEqual([...seen].sort((a, b) => a - b), payloads);
  const counts = await q.counts("batch");
  assert.equal(counts.completed, payloads.length);
});

test("concurrency cap: never more than `concurrency` handlers run at once", async () => {
  const q = new MemoryQueue();
  const concurrency = 2;
  const total = 6;

  let running = 0;
  let peak = 0;
  // One gate per message so we control exactly when handlers release.
  const gates = Array.from({ length: total }, () => deferred());

  await q.work<number>(
    "gated",
    async (msg) => {
      running += 1;
      peak = Math.max(peak, running);
      const gate = gates[msg.payload];
      assert.ok(gate, `expected a gate for payload ${msg.payload}`);
      await gate.promise;
      running -= 1;
    },
    { concurrency },
  );

  await q.sendMany("gated", Array.from({ length: total }, (_, i) => i));

  // Let the queue start as many handlers as it will. Microtasks have flushed
  // by the time this await resolves, so the queue is saturated to its cap.
  await new Promise((r) => setTimeout(r, 10));

  // Mid-flight: exactly `concurrency` handlers must be active, no more.
  assert.equal(peak, concurrency, "peak concurrency must equal the cap mid-flight");
  const midCounts = await q.counts("gated");
  assert.equal(midCounts.running, concurrency, "running count must equal the cap");
  assert.equal(midCounts.queued, total - concurrency, "the rest must be queued");

  // Release everything, draining wave by wave; peak must never exceed the cap.
  for (const g of gates) g.resolve();
  await q.idle();

  assert.equal(peak, concurrency, "peak concurrency must never exceed the cap");
  assert.equal(running, 0);
  const finalCounts = await q.counts("gated");
  assert.equal(finalCounts.completed, total);
  assert.equal(finalCounts.running, 0);
  assert.equal(finalCounts.queued, 0);
});

test("retry-on-throw: always-throwing handler is attempted retryLimit+1 times then fails", async () => {
  const q = new MemoryQueue();
  const attemptsSeen: number[] = [];

  await q.work<string>(
    "always-fail",
    async (msg) => {
      attemptsSeen.push(msg.attempts);
      throw new Error("boom");
    },
    { concurrency: 1, retryLimit: 2 },
  );

  await q.send("always-fail", "x");
  await q.idle();

  // retryLimit: 2 → 3 total deliveries, with attempts 1, 2, 3.
  assert.deepEqual(attemptsSeen, [1, 2, 3]);
  const counts = await q.counts("always-fail");
  assert.equal(counts.failed, 1);
  assert.equal(counts.completed, 0);
  assert.equal(counts.queued, 0);
  assert.equal(counts.running, 0);
});

test("retry-on-throw: handler that throws once then succeeds ends completed", async () => {
  const q = new MemoryQueue();
  const attemptsSeen: number[] = [];

  await q.work<string>(
    "flaky",
    async (msg) => {
      attemptsSeen.push(msg.attempts);
      if (msg.attempts === 1) throw new Error("transient");
      // second delivery succeeds
    },
    { concurrency: 1, retryLimit: 2 },
  );

  await q.send("flaky", "y");
  await q.idle();

  assert.deepEqual(attemptsSeen, [1, 2]);
  const counts = await q.counts("flaky");
  assert.equal(counts.completed, 1);
  assert.equal(counts.failed, 0);
});

test("msg.attempts increments by one per delivery (1,2,3,…)", async () => {
  const q = new MemoryQueue();
  const attemptsSeen: number[] = [];

  await q.work<string>(
    "counting",
    async (msg: QueueMessage<string>) => {
      attemptsSeen.push(msg.attempts);
      throw new Error("retry me");
    },
    { concurrency: 1, retryLimit: 4 },
  );

  await q.send("counting", "z");
  await q.idle();

  // 4 retries on top of the first delivery → 5 attempts, strictly increasing by 1.
  assert.deepEqual(attemptsSeen, [1, 2, 3, 4, 5]);
});

test("idle() resolves only after all queued + active work finishes, including retries", async () => {
  const q = new MemoryQueue();
  let processed = 0;
  const gate = deferred();

  await q.work<number>(
    "drain",
    async (msg) => {
      // First message blocks on a gate; the rest are quick. One message also
      // retries once, so idle() must wait for that redelivery too.
      if (msg.payload === 0) {
        await gate.promise;
      }
      if (msg.payload === 1 && msg.attempts === 1) {
        throw new Error("retry once");
      }
      processed += 1;
    },
    { concurrency: 2, retryLimit: 1 },
  );

  await q.sendMany("drain", [0, 1, 2]);

  let idleSettled = false;
  const idle = q.idle().then(() => {
    // Capture whether we were still blocked when idle resolved.
    idleSettled = true;
  });

  // Give the queue time to work everything that *can* finish while gate holds.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(idleSettled, false, "idle() must not resolve while a handler is still active");

  // Release the blocking handler; now everything can drain.
  gate.resolve();
  await idle;

  const counts = await q.counts("drain");
  // 3 distinct messages; message 1 was delivered twice but is one item.
  assert.equal(counts.completed, 3);
  assert.equal(counts.failed, 0);
  assert.equal(counts.queued, 0);
  assert.equal(counts.running, 0);
  assert.equal(processed, 3);
});

test("counts() reconcile: completed + failed equals total sent, none left in flight", async () => {
  const q = new MemoryQueue();
  const total = 10;

  await q.work<number>(
    "reconcile",
    async (msg) => {
      // Even payloads succeed; odd payloads always throw → fail terminally.
      if (msg.payload % 2 === 1) throw new Error("odd fails");
    },
    { concurrency: 4, retryLimit: 1 },
  );

  await q.sendMany("reconcile", Array.from({ length: total }, (_, i) => i));
  await q.idle();

  const counts = await q.counts("reconcile");
  const expectedCompleted = total / 2; // even payloads
  const expectedFailed = total / 2; // odd payloads

  assert.equal(counts.completed, expectedCompleted);
  assert.equal(counts.failed, expectedFailed);
  assert.equal(counts.queued, 0);
  assert.equal(counts.running, 0);
  assert.equal(
    counts.completed + counts.failed + counts.queued + counts.running,
    total,
    "all sent items must be accounted for across the four states",
  );
});
