/**
 * syncOcrQuality's failure paths that the HTTP tests cannot reach: a queue
 * send that fails after the claim was won, and a release that fails too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryBlobStore } from "../core/blob.js";
import { createMemoryLogger } from "../core/logger.js";
import { MemoryQueue } from "../core/queue-memory.js";
import { MemoryOcrBackfillStore } from "../domain/ocr-backfill-memory.js";
import { OCR_BACKFILL_REASON, type OcrBackfillMark, type OcrBackfillPolicy } from "../domain/ocr-backfill.js";
import { syncOcrQuality } from "./ocr-quality-sync.js";

const ARK = "ark:/12148/bpt6k4625753w";
const POLICY: OcrBackfillPolicy = {
  retryFailedAfterMs: 60_000,
  maxAttempts: 5,
  startedStaleAfterMs: 90 * 60 * 1_000,
  unstartedStaleAfterMs: 14 * 24 * 60 * 60 * 1_000,
};
const LIVE = new AbortController().signal;

class DownQueue extends MemoryQueue {
  override async send(): Promise<void> {
    throw new Error("pg-boss down");
  }
}

class StuckStore extends MemoryOcrBackfillStore {
  override async markFailed(): Promise<OcrBackfillMark> {
    throw new Error("db down");
  }
}

test("a failed send releases the claim as a retryable enqueue_failed", async () => {
  const store = new MemoryOcrBackfillStore();
  const { logger } = createMemoryLogger();
  const res = await syncOcrQuality(
    { blob: new MemoryBlobStore(), queue: new DownQueue(), log: logger, backfill: { store, enabled: true, policy: POLICY, concurrency: 1 } },
    [ARK],
    LIVE,
  );
  assert.deepEqual(res.unavailable, [{ ark: ARK, reason: `${OCR_BACKFILL_REASON.ENQUEUE_FAILED}: pg-boss down` }]);
  const row = await store.get(ARK);
  assert.deepEqual([row?.state, row?.permanent], ["failed", false]);
});

test("a failed release never masks the send error: answered with it, both logged", async () => {
  const store = new StuckStore();
  const { logger, lines } = createMemoryLogger();
  const res = await syncOcrQuality(
    { blob: new MemoryBlobStore(), queue: new DownQueue(), log: logger, backfill: { store, enabled: true, policy: POLICY, concurrency: 1 } },
    [ARK],
    LIVE,
  );
  assert.deepEqual(res.unavailable, [{ ark: ARK, reason: `${OCR_BACKFILL_REASON.ENQUEUE_FAILED}: pg-boss down` }]);
  const released = lines.find((l) => l.event === "ocr_quality_enqueue_release_failed");
  assert.ok(released);
  assert.equal(released.releaseError, "db down");
  assert.equal((await store.get(ARK))?.state, "queued", "the staleness rule recovers it later");
});

test("an aborted signal rejects before any ARK is read", async () => {
  const controller = new AbortController();
  controller.abort(new Error("deadline"));
  const store = new MemoryOcrBackfillStore();
  const { logger } = createMemoryLogger();
  await assert.rejects(
    syncOcrQuality(
      { blob: new MemoryBlobStore(), queue: new MemoryQueue(), log: logger, backfill: { store, enabled: true, policy: POLICY, concurrency: 1 } },
      [ARK],
      controller.signal,
    ),
    /deadline/,
  );
  assert.equal(await store.get(ARK), null);
});
