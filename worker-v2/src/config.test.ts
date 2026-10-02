/**
 * loadOcrBackfillConfig — the OCR backfill knobs are validated at startup:
 * unset means the documented default, anything set must be well-formed (a
 * fractional or non-positive concurrency or retry age, or a boolean typo,
 * throws instead of being floored or ignored).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_OCR_BACKFILL_CONCURRENCY,
  DEFAULT_OCR_BACKFILL_ENABLED,
  DEFAULT_OCR_BACKFILL_RETRY_FAILED_AFTER_MS,
  loadOcrBackfillConfig,
} from "./config.js";

test("unset → the documented defaults (D6: enabled, concurrency 2, 24 h base backoff)", () => {
  assert.deepEqual(loadOcrBackfillConfig({}), {
    enabled: DEFAULT_OCR_BACKFILL_ENABLED,
    concurrency: DEFAULT_OCR_BACKFILL_CONCURRENCY,
    retryFailedAfterMs: DEFAULT_OCR_BACKFILL_RETRY_FAILED_AFTER_MS,
  });
  assert.equal(DEFAULT_OCR_BACKFILL_CONCURRENCY, 2);
});

test("well-formed values are used as given", () => {
  assert.deepEqual(
    loadOcrBackfillConfig({
      OCR_BACKFILL_ENABLED: "false",
      OCR_BACKFILL_CONCURRENCY: "4",
      OCR_BACKFILL_RETRY_FAILED_AFTER_MS: "3600000",
    }),
    { enabled: false, concurrency: 4, retryFailedAfterMs: 3_600_000 },
  );
});

test("malformed values throw", () => {
  for (const env of [
    { OCR_BACKFILL_CONCURRENCY: "0" },
    { OCR_BACKFILL_CONCURRENCY: "1.5" },
    { OCR_BACKFILL_CONCURRENCY: "two" },
    { OCR_BACKFILL_RETRY_FAILED_AFTER_MS: "-1" },
    { OCR_BACKFILL_RETRY_FAILED_AFTER_MS: "0" },
    { OCR_BACKFILL_ENABLED: "yes" },
  ]) {
    assert.throws(() => loadOcrBackfillConfig(env), /OCR_BACKFILL_/, JSON.stringify(env));
  }
});
