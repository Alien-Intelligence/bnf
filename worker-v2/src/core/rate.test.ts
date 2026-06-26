/**
 * Unit tests for the token-bucket RateLimiter (core/rate.ts).
 *
 * The token arithmetic is exercised with an injected clock (`now`) so refill
 * is deterministic and needs no real waiting; the FIFO/blocking behaviour of
 * `acquire()` is exercised with REAL timers at a small high rate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { RateLimiter } from "./rate.js";

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
  await limiter.acquire();

  // Bucket now empty. Fire several acquires; record completion order.
  const order: number[] = [];
  const ps = [0, 1, 2, 3].map((i) =>
    limiter.acquire().then(() => {
      order.push(i);
    }),
  );

  await Promise.all(ps);

  assert.deepEqual(order, [0, 1, 2, 3], "waiters resolve in FIFO order");

  limiter.stop();
});

test("stop releases blocked acquirers and acquire after stop rejects", async () => {
  // Very low rate so tokens won't naturally arrive during the test window.
  const limiter = new RateLimiter({ ratePerMin: 1, burst: 1 });

  // Consume the single token.
  await limiter.acquire();

  // These block (bucket empty, ~60s until next token).
  const blocked = [limiter.acquire(), limiter.acquire()];

  // Settle each as fulfilled/rejected without hanging.
  const settled = Promise.allSettled(blocked);

  limiter.stop();

  const results = await settled;
  for (const r of results) {
    assert.ok(
      r.status === "fulfilled" || r.status === "rejected",
      "blocked acquirer settled (did not hang)",
    );
  }

  // acquire() after stop rejects.
  await assert.rejects(() => limiter.acquire(), /stopped/i, "acquire after stop rejects");
});

test("constructor rejects ratePerMin <= 0", () => {
  assert.throws(() => new RateLimiter({ ratePerMin: 0 }), /ratePerMin must be > 0/);
  assert.throws(() => new RateLimiter({ ratePerMin: -5 }), /ratePerMin must be > 0/);
});
