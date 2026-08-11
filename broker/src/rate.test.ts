/**
 * Unit tests for the broker TokenBucket (rate.ts) — the F3/F5 incident fixes.
 *
 * All bucket tests use an injected fake clock: `now`/`wallNow` read a shared
 * mutable `t`, and `sleep` advances `t` by the requested amount before
 * resolving (a microtask, not a real timer) — so the deadline/refill/freeze
 * arithmetic is exercised deterministically with zero real elapsed time. Only
 * the `retryAfterToEpochMs` tests use the real wall clock, because that
 * function is untouched by this fix and intentionally reads `Date.now()`
 * directly (not injectable) — see its own file header.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { RateWaitTimeoutError, retryAfterToEpochMs, TokenBucket } from "./rate.js";

/** A fake clock + sleep triple sharing one mutable instant, for deterministic tests. */
function fakeClock(): {
  now: () => number;
  wallNow: () => number;
  sleep: (ms: number) => Promise<void>;
  sleeps: number[];
  time: () => number;
} {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    wallNow: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    sleeps,
    time: () => t,
  };
}

test("enqueue-time deadline: a caller queued behind a slow chain sheds at its OWN deadline, never a fresh budget at chain-arrival", async () => {
  // rpm=60 (burst=1) => once the bucket is empty, refilling one token takes a
  // fixed 1000ms — i.e. every queued acquirer after the first pays the same
  // 1000ms toll. Three callers ahead of B accumulate 2000ms of real queueing
  // delay before B's turn arrives.
  const clock = fakeClock();
  const bucket = new TokenBucket({
    rpm: 60,
    burst: 1,
    now: clock.now,
    wallNow: clock.wallNow,
    sleep: clock.sleep,
  });

  // All four `acquire()` calls happen "at t=0" (synchronously, before any of
  // them is awaited) — this is the enqueue instant each deadline is captured
  // from, per F3.
  const f1 = bucket.acquire(10_000); // burst token is free — resolves without waiting
  const f2 = bucket.acquire(10_000); // must wait out a full refill (1000ms)
  const f3 = bucket.acquire(10_000); // must wait out another full refill (1000ms)
  // B's own budget (1500ms) is LESS than the ~2000ms of queueing time it will
  // actually sit behind F1–F3, but MORE than the 1000ms refill wait it would
  // need once it's finally its turn — the exact shape of the incident: a
  // fresh-budget-at-arrival check would grant it (1000 < 1500), the
  // enqueue-time deadline correctly does not (1500 already spent queueing).
  const b = bucket.acquire(1_500);

  const results = await Promise.allSettled([f1, f2, f3, b]);

  assert.equal(results[0]?.status, "fulfilled", "F1 (free token) succeeds");
  assert.equal(results[1]?.status, "fulfilled", "F2 (one refill wait) succeeds");
  assert.equal(results[2]?.status, "fulfilled", "F3 (one refill wait) succeeds");
  assert.equal(results[3]?.status, "rejected", "B is shed");
  const bResult = results[3];
  assert.ok(bResult.status === "rejected");
  assert.ok(bResult.reason instanceof RateWaitTimeoutError);

  // The decisive assertion: B's rejection did NOT cost a further sleep. Only
  // F2 and F3 ever called `sleep` (1000ms each); B rejected the instant its
  // turn in the chain arrived, at t=2000 — its wait was governed by its OWN
  // deadline (1500ms from t=0), not a fresh allowance measured from
  // chain-arrival (which would have granted it after one more 1000ms sleep).
  assert.deepEqual(clock.sleeps, [1000, 1000], "B never triggered its own sleep");
  assert.equal(clock.time(), 2000, "no additional time elapsed serving B");
});

test("freeze shedding: a caller with a budget shorter than an active penalty freeze sheds without sleeping", async () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({
    rpm: 60,
    burst: 1,
    now: clock.now,
    wallNow: clock.wallNow,
    sleep: clock.sleep,
  });

  // Simulate a 429 whose Retry-After freezes the bucket far into the future.
  bucket.penalizeUntil(clock.wallNow() + 100_000);

  await assert.rejects(
    () => bucket.acquire(50),
    RateWaitTimeoutError,
    "budget (50ms) is far shorter than the freeze (100s) — shed immediately",
  );
  assert.deepEqual(clock.sleeps, [], "no sleep — the freeze alone already exceeds the budget");
});

test("freeze shedding: a queued burst behind a freeze all reject fast, not serially through the freeze window", async () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({
    rpm: 60,
    burst: 1,
    now: clock.now,
    wallNow: clock.wallNow,
    sleep: clock.sleep,
  });

  bucket.penalizeUntil(clock.wallNow() + 100_000);

  const callers = [bucket.acquire(10), bucket.acquire(20), bucket.acquire(30)];
  const results = await Promise.allSettled(callers);

  for (const [i, r] of results.entries()) {
    assert.equal(r.status, "rejected", `caller ${i} sheds instead of queueing through the freeze`);
  }
  assert.deepEqual(clock.sleeps, [], "the whole burst rejects without a single sleep");
});

test("FIFO order preserved: acquirers with generous budgets are served in arrival order", async () => {
  const clock = fakeClock();
  // burst=1, rpm=6000 => 10ms per token once empty.
  const bucket = new TokenBucket({
    rpm: 6000,
    burst: 1,
    now: clock.now,
    wallNow: clock.wallNow,
    sleep: clock.sleep,
  });

  const order: number[] = [];
  const acquirers = [0, 1, 2].map((i) => bucket.acquire(10_000).then(() => order.push(i)));
  await Promise.all(acquirers);

  assert.deepEqual(order, [0, 1, 2], "resolved in the order they called acquire()");
});

test("penalizeUntil freezes only the bucket it's called on — a separate instance is unaffected (F5)", async () => {
  const clock = fakeClock();
  const manifest = new TokenBucket({
    rpm: 40,
    burst: 4,
    now: clock.now,
    wallNow: clock.wallNow,
    sleep: clock.sleep,
  });
  const global = new TokenBucket({
    rpm: 1000,
    burst: 20,
    now: clock.now,
    wallNow: clock.wallNow,
    sleep: clock.sleep,
  });

  // A manifest 429 freezes the manifest bucket...
  manifest.penalizeUntil(clock.wallNow() + 100_000);
  await assert.rejects(() => manifest.acquire(10), RateWaitTimeoutError);

  // ...but the global bucket — a wholly separate instance — is untouched.
  await assert.doesNotReject(() => global.acquire(10));
  assert.deepEqual(clock.sleeps, [], "both settled without needing to sleep");
});

test("consumeOne errs low: a caller does not get a token before the refill math says one exists", async () => {
  const clock = fakeClock();
  const bucket = new TokenBucket({
    rpm: 60,
    burst: 1,
    now: clock.now,
    wallNow: clock.wallNow,
    sleep: clock.sleep,
  });

  await bucket.acquire(10_000); // consumes the initial burst token
  const before = clock.time();
  await bucket.acquire(10_000); // must wait a full 1000ms refill
  assert.equal(clock.time() - before, 1000, "waited exactly the modelled refill time, not less");
});

test("retryAfterToEpochMs: no header falls back to the next wall-clock :00 boundary when the fallback is generous", () => {
  const before = Date.now();
  // 10-minute fallback so the (always <=60s away) clock-minute boundary wins.
  const result = retryAfterToEpochMs(undefined, 600_000);
  assert.ok(result > before, "freeze deadline is in the future");
  assert.ok(result <= before + 60_000 + 5, "never further out than the next clock-minute boundary");
  assert.equal(result % 60_000, 0, "aligned to a wall-clock :00 boundary, not `now + fallback`");
});

test("retryAfterToEpochMs: an unparseable (French-localized) Retry-After falls back to the boundary too", () => {
  const result = retryAfterToEpochMs("mar. 12 août 2026 10:15:00 GMT", 600_000);
  assert.equal(result % 60_000, 0, "Date.parse fails on the French date -> same boundary fallback");
});

test("retryAfterToEpochMs: a small fallback caps the freeze below the clock-minute boundary", () => {
  const before = Date.now();
  const result = retryAfterToEpochMs(undefined, 1_000);
  assert.ok(result <= before + 1_000 + 5, "capped by fallbackMs when that is sooner than the :00 boundary");
});

test("retryAfterToEpochMs: a bare integer header is honored as delta-seconds from now", () => {
  const before = Date.now();
  const result = retryAfterToEpochMs("5", 60_000);
  const after = Date.now();
  assert.ok(result >= before + 5000 && result <= after + 5000, "now + 5s, verbatim");
});

test("retryAfterToEpochMs: a parseable future GMT date is honored verbatim", () => {
  const future = new Date(Math.floor((Date.now() + 12_345) / 1000) * 1000); // whole seconds
  const result = retryAfterToEpochMs(future.toUTCString(), 60_000);
  assert.equal(result, future.getTime());
});

test("constructor validates rpm and burst", () => {
  assert.throws(() => new TokenBucket({ rpm: 0, burst: 1 }), /rpm must be > 0/);
  assert.throws(() => new TokenBucket({ rpm: -5, burst: 1 }), /rpm must be > 0/);
  assert.throws(() => new TokenBucket({ rpm: 60, burst: 0 }), /burst must be >= 1/);
});
