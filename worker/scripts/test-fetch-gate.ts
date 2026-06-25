/**
 * Self-contained assertions for the process-global fetch gate. No test runner in
 * this sandbox, so this is a tsx-runnable script: `npx tsx scripts/test-fetch-gate.ts`.
 * Exits 0 on pass, 1 on the first failed assertion. Covers the three properties
 * the gate must guarantee: it never exceeds N in flight, it releases the permit on
 * BOTH success and throw, and it wakes waiters FIFO (no starvation).
 *
 * PERMITS is read once at module load, so we set the env BEFORE importing the gate.
 */
import assert from "node:assert/strict";

process.env.BNF_FETCH_CONCURRENCY = "3";
const { withFetchPermit, fetchGatePermits } = await import("../src/prepare/fetch-gate.js");

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function testPermitCount(): Promise<void> {
  assert.equal(fetchGatePermits(), 3, "BNF_FETCH_CONCURRENCY=3 should yield 3 permits");
}

async function testNeverExceedsN(): Promise<void> {
  let inFlight = 0;
  let peak = 0;
  const gates = Array.from({ length: 30 }, () =>
    withFetchPermit(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
    }),
  );
  await Promise.all(gates);
  assert.ok(peak <= 3, `peak in-flight ${peak} exceeded the 3 permits`);
  assert.equal(inFlight, 0, "all permits should be released at the end");
}

async function testReleasesOnThrow(): Promise<void> {
  // Saturate all 3 permits with throwing tasks; if a permit leaked on throw, the
  // 4th task below would deadlock (and the test would time out → CI failure).
  const throwers = Array.from({ length: 3 }, () =>
    withFetchPermit(async () => {
      throw new Error("boom");
    }).catch(() => "handled"),
  );
  await Promise.all(throwers);
  const after = await withFetchPermit(async () => "ok");
  assert.equal(after, "ok", "a permit must be reclaimed after a thrown task");
}

async function testFifoWakeup(): Promise<void> {
  // Hold all 3 permits, then queue 3 more waiters in a known order; the order they
  // run as permits free must match enqueue order.
  const blockers = Array.from({ length: 3 }, () => defer());
  const held = blockers.map((b, i) =>
    withFetchPermit(async () => {
      await b.promise;
      return i;
    }),
  );
  await sleep(5); // ensure the 3 holders have acquired

  const order: number[] = [];
  const waiters = [0, 1, 2].map((id) =>
    withFetchPermit(async () => {
      order.push(id);
      await sleep(5);
    }),
  );
  await sleep(5); // waiters are now queued FIFO

  // Release the holders one at a time; each frees a permit handed to the earliest waiter.
  for (const b of blockers) {
    b.resolve();
    await sleep(15);
  }
  await Promise.all([...held, ...waiters]);
  assert.deepEqual(order, [0, 1, 2], `waiters woke out of order: ${order.join(",")}`);
}

const tests: Array<[string, () => Promise<void>]> = [
  ["permit count from env", testPermitCount],
  ["never exceeds N in flight", testNeverExceedsN],
  ["releases permit on throw", testReleasesOnThrow],
  ["FIFO waiter wakeup", testFifoWakeup],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL - ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall fetch-gate assertions passed");
