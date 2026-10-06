/**
 * Unit tests for the token-bucket RateLimiter (core/rate.ts).
 *
 * The token arithmetic is exercised with an injected clock (`now`) so refill
 * is deterministic and needs no real waiting; the FIFO/blocking behaviour of
 * `acquire()` is exercised with REAL timers at a small high rate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { acquireWithin, CompositeRateGate, RateGateStoppedError, RateGateTimeoutError, RateLimiter } from "./rate.js";
import type { RateGate } from "./types.js";

/** A signal that never aborts — for the cases not about cancellation. */
const LIVE = new AbortController().signal;

test("starts full at burst capacity; tryAcquire consumes one; false when empty", () => {
  const t = 0; // clock never advances in this test
  const limiter = new RateLimiter({ ratePerMin: 60, burst: 3, now: () => t });

  assert.equal(limiter.available(), 3, "bucket starts at burst capacity");

  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.available(), 2, "one token consumed");

  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.available(), 0, "bucket drained");

  assert.equal(limiter.tryAcquire(), false, "returns false when empty");

  limiter.stop();
});

test("refill is time-based via the injected clock at ratePerMin/60000 per ms, capped at burst", () => {
  let t = 0;
  // 60/min => 1 token per 1000 ms => 0.001 token/ms.
  const limiter = new RateLimiter({ ratePerMin: 60, burst: 5, now: () => t });

  // Drain the bucket.
  for (let i = 0; i < 5; i++) assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.available(), 0);

  // Advance 500 ms => 0.5 token.
  t = 500;
  assert.equal(limiter.available(), 0.5, "0.5 token after 500ms at 60/min");

  // Advance to 2000 ms total => 2 tokens.
  t = 2000;
  assert.equal(limiter.available(), 2, "2 tokens after 2000ms");

  // Advance far beyond capacity => capped at burst.
  t = 1_000_000;
  assert.equal(limiter.available(), 5, "refill capped at burst capacity");

  limiter.stop();
});

test("msUntilToken returns 0 when available and the correct positive wait when empty", () => {
  let t = 0;
  // 120/min => 2 tokens/1000ms => 0.002 token/ms => 1 token every 500ms.
  const limiter = new RateLimiter({ ratePerMin: 120, burst: 2, now: () => t });

  assert.equal(limiter.msUntilToken(), 0, "token available -> 0");

  // Drain.
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.available(), 0);

  // Empty: need 1 full token. refillPerMs = 0.002 => ceil(1 / 0.002) = 500ms.
  assert.equal(limiter.msUntilToken(), 500, "wait for a full token when empty");

  // Advance 200ms => 0.4 token => need (1 - 0.4)/0.002 = 300ms more.
  t = 200;
  assert.equal(limiter.msUntilToken(), 300, "partial refill shortens the wait");

  limiter.stop();
});

test("never exceeds the rate over a simulated window", () => {
  let t = 0;
  const ratePerMin = 300;
  const burst = 5;
  const limiter = new RateLimiter({ ratePerMin, burst, now: () => t });

  const windowMs = 60_000; // one minute
  const stepMs = 100; // poll every 100ms
  let acquired = 0;

  // Walk a controlled minute, greedily acquiring whenever possible.
  for (t = 0; t <= windowMs; t += stepMs) {
    while (limiter.tryAcquire()) acquired++;
  }

  // Theoretical ceiling: the burst already in the bucket at t=0, plus the
  // tokens refilled over the window. We must never exceed that.
  const maxAllowed = burst + (ratePerMin / 60_000) * windowMs; // 5 + 300 = 305
  assert.ok(
    acquired <= maxAllowed,
    `acquired ${acquired} must not exceed rate ceiling ${maxAllowed}`,
  );
  // And we should be close to it (greedy draining): within burst of the cap.
  assert.ok(
    acquired >= maxAllowed - burst,
    `acquired ${acquired} should be near the ceiling ${maxAllowed}`,
  );

  limiter.stop();
});

test("acquire resolves immediately when a token is free; empty acquires resolve FIFO as tokens refill", async () => {
  // Real timers, small high rate: 6000/min => 100 tokens/sec => 1 token / 10ms.
  const limiter = new RateLimiter({ ratePerMin: 6000, burst: 1 });

  // One token in the bucket -> first acquire resolves immediately.
  await limiter.acquire(LIVE);

  // Bucket now empty. Fire several acquires; record completion order.
  const order: number[] = [];
  const ps = [0, 1, 2, 3].map((i) =>
    limiter.acquire(LIVE).then(() => {
      order.push(i);
    }),
  );

  await Promise.all(ps);

  assert.deepEqual(order, [0, 1, 2, 3], "waiters resolve in FIFO order");

  limiter.stop();
});

test("stop REJECTS blocked acquirers — never lets them through ungated — and acquire after stop rejects", async () => {
  // Very low rate so tokens won't naturally arrive during the test window.
  const limiter = new RateLimiter({ ratePerMin: 1, burst: 1 });
  await limiter.acquire(LIVE); // consume the single token
  const blocked = [limiter.acquire(LIVE), limiter.acquire(LIVE)];
  const settled = Promise.allSettled(blocked);
  limiter.stop();
  const results = await settled;
  for (const r of results) {
    assert.equal(r.status, "rejected", "a waiter is refused, never granted, on stop");
    assert.ok(r.status === "rejected" && r.reason instanceof RateGateStoppedError);
  }
  await assert.rejects(() => limiter.acquire(LIVE), RateGateStoppedError, "acquire after stop rejects");
});

test("constructor rejects ratePerMin <= 0", () => {
  assert.throws(() => new RateLimiter({ ratePerMin: 0 }), /ratePerMin must be > 0/);
  assert.throws(() => new RateLimiter({ ratePerMin: -5 }), /ratePerMin must be > 0/);
});

test("acquire(signal): an aborted waiter rejects with the signal's reason and gives up its place", async () => {
  const limiter = new RateLimiter({ ratePerMin: 60, burst: 1 });
  await limiter.acquire(LIVE); // empty the bucket
  const controller = new AbortController();
  const waiting = limiter.acquire(controller.signal);
  controller.abort(new Error("deadline"));
  await assert.rejects(waiting, /deadline/);
  assert.equal(limiter.pendingWaiters(), 0, "the aborted waiter left the queue");
  limiter.stop();
});

test("acquire(signal): an already-aborted signal rejects at once", async () => {
  const limiter = new RateLimiter({ ratePerMin: 60, burst: 1 });
  const controller = new AbortController();
  controller.abort(new Error("too late"));
  await assert.rejects(limiter.acquire(controller.signal), /too late/);
  assert.equal(limiter.available() >= 1, true, "no token was consumed");
  limiter.stop();
});


test("acquire(signal): an abort mid-queue keeps FIFO order for the rest", async () => {
  // 6000/min = one token per 10 ms; the bucket starts with one.
  const limiter = new RateLimiter({ ratePerMin: 6000, burst: 1 });
  await limiter.acquire(LIVE);
  const order: string[] = [];
  const middle = new AbortController();
  const first = limiter.acquire(LIVE).then(() => order.push("first"));
  const second = limiter.acquire(middle.signal).then(
    () => order.push("second"),
    () => order.push("second-aborted"),
  );
  const third = limiter.acquire(LIVE).then(() => order.push("third"));
  middle.abort(new Error("gone"));
  await Promise.all([first, second, third]);
  assert.deepEqual(order, ["second-aborted", "first", "third"]);
  assert.equal(limiter.pendingWaiters(), 0);
  limiter.stop();
});

test("acquire(signal): an abort AFTER the grant changes nothing", async () => {
  const limiter = new RateLimiter({ ratePerMin: 60, burst: 1 });
  const controller = new AbortController();
  await limiter.acquire(controller.signal);
  controller.abort(new Error("late"));
  assert.equal(limiter.pendingWaiters(), 0);
  limiter.stop();
});

test("acquireWithin: a wait past its deadline rejects with RateGateTimeoutError and frees its place", async () => {
  const limiter = new RateLimiter({ ratePerMin: 1, burst: 1 });
  await limiter.acquire(LIVE);
  await assert.rejects(
    () => acquireWithin(limiter, 20),
    (e: unknown) => e instanceof RateGateTimeoutError && e.waitedMs === 20,
  );
  assert.equal(limiter.pendingWaiters(), 0);
  limiter.stop();
});

// --- CompositeRateGate: one token from each nested BnF quota ----------------

/** A gate whose grants the test releases by hand, recording the signal it got. */
class ManualGate implements RateGate {
  readonly waiting: Array<() => void> = [];
  readonly signals: AbortSignal[] = [];
  constructor(readonly ratePerMin: number) {}
  acquire(signal: AbortSignal): Promise<void> {
    this.signals.push(signal);
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      this.waiting.push(resolve);
    });
  }
  grant(): void {
    this.waiting.shift()?.();
  }
}

/** Let pending promise callbacks run. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

test("CompositeRateGate: acquire resolves only once EVERY gate granted, specific gate first, global last", async () => {
  const api = new ManualGate(1425);
  const global = new ManualGate(950);
  const gate = new CompositeRateGate([api, global]);
  let granted = false;
  const p = gate.acquire(LIVE).then(() => {
    granted = true;
  });
  await settle();
  assert.equal(api.waiting.length, 1, "waits on the specific gate first");
  assert.equal(global.waiting.length, 0, "holds no global token while the API gate is empty");
  api.grant();
  await settle();
  assert.equal(global.waiting.length, 1, "then waits on global");
  assert.equal(granted, false, "not granted with only the API token");
  global.grant();
  await p;
  assert.equal(granted, true);
  assert.deepEqual([api.signals[0], global.signals[0]], [LIVE, LIVE], "the caller's signal bounds every wait");
});

test("CompositeRateGate: ratePerMin is the binding (smallest) rate", () => {
  assert.equal(new CompositeRateGate([new ManualGate(1425), new ManualGate(950)]).ratePerMin, 950);
  assert.equal(new CompositeRateGate([new ManualGate(38), new ManualGate(1425), new ManualGate(950)]).ratePerMin, 38);
});

test("CompositeRateGate: an empty gate list is a wiring error", () => {
  assert.throws(() => new CompositeRateGate([]), /at least one gate/);
});

test("CompositeRateGate: a stopped inner gate rejects the composite with RateGateStoppedError (shutdown hands back)", async () => {
  const api = new RateLimiter({ ratePerMin: 60, burst: 1 });
  const global = new RateLimiter({ ratePerMin: 60, burst: 1 });
  global.stop();
  await assert.rejects(() => new CompositeRateGate([api, global]).acquire(LIVE), RateGateStoppedError);
  api.stop();
});

test("CompositeRateGate: acquireWithin bounds the whole composite wait", async () => {
  const api = new ManualGate(60);
  const global = new ManualGate(60);
  await assert.rejects(() => acquireWithin(new CompositeRateGate([api, global]), 20), RateGateTimeoutError);
});
