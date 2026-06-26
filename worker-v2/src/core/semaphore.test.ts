import { test } from "node:test";
import assert from "node:assert/strict";

import { Semaphore } from "./semaphore.js";

test("Semaphore caps concurrency at max and runs everything", async () => {
  const sem = new Semaphore(3);
  let inFlight = 0;
  let peak = 0;
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      sem.run(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return i;
      }),
    ),
  );
  assert.equal(peak, 3, "never exceeded max in-flight");
  assert.deepEqual(results.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("Semaphore releases the slot even when the task throws", async () => {
  const sem = new Semaphore(1);
  await assert.rejects(() => sem.run(async () => { throw new Error("boom"); }));
  // If the slot leaked, this second run would hang forever.
  const ok = await sem.run(async () => "recovered");
  assert.equal(ok, "recovered");
});

test("Semaphore rejects a non-positive max", () => {
  assert.throws(() => new Semaphore(0));
});
