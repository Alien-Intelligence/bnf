/**
 * Contract test for OcrBackfillStore — the SAME cases run against the memory
 * store and the Postgres store, so the two cannot drift (the review found the
 * pg store a silent no-op where the fake threw, and counts() that disagreed).
 *
 * The pg variant runs against a real database: set WORKER_TEST_DATABASE_URL to
 * the worker's Postgres (it applies schema.sql, which is idempotent, and only
 * touches rows it creates under a unique ARK prefix, deleted afterwards).
 * Without it the pg suite is reported as SKIPPED, never silently passed.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";

import { MemoryOcrBackfillStore } from "./ocr-backfill-memory.js";
import { OCR_BACKFILL_TABLE, PgOcrBackfillStore } from "./ocr-backfill-pg.js";
import { PgDocState } from "./doc-state-pg.js";
import {
  OCR_BACKFILL_EXPIRED,
  retryBackoffMs,
  validateOcrBackfillPolicy,
  type OcrBackfillPolicy,
  type OcrBackfillStore,
} from "./ocr-backfill.js";

const POLICY: OcrBackfillPolicy = {
  retryFailedAfterMs: 60_000,
  maxAttempts: 3,
  queuedStaleAfterMs: 600_000,
};

interface Fixture {
  store: OcrBackfillStore;
  /** Advance the store's clock. */
  advance: (ms: number) => void;
  /** A fresh ARK no other case uses. */
  ark: () => string;
}

function contract(name: string, make: () => Promise<Fixture>, opts: { skip?: string } = {}): void {
  describe(`OcrBackfillStore contract — ${name}`, { skip: opts.skip }, () => {
    test("first request enqueues; a second one finds it queued", async () => {
      const f = await make();
      const ark = f.ark();
      assert.deepEqual(await f.store.request(ark, POLICY), { kind: "enqueue" });
      assert.deepEqual(await f.store.request(ark, POLICY), { kind: "queued" });
      assert.equal((await f.store.get(ark))?.attempts, 0);
    });

    test("a done row reaching request lost its artifact: re-opened with attempts reset", async () => {
      const f = await make();
      const ark = f.ark();
      await f.store.request(ark, POLICY);
      await f.store.markFailed(ark, "boom", { permanent: false });
      f.advance(retryBackoffMs(POLICY, 1));
      await f.store.request(ark, POLICY);
      await f.store.markDone(ark);
      assert.deepEqual(await f.store.request(ark, POLICY), { kind: "enqueue" });
      const row = await f.store.get(ark);
      assert.equal(row?.state, "queued");
      assert.equal(row?.attempts, 0);
    });

    test("a transient failure is retried after an exponential backoff, keeping its attempt count", async () => {
      const f = await make();
      const ark = f.ark();
      await f.store.request(ark, POLICY);
      await f.store.markFailed(ark, "build_failed: 503", { permanent: false });
      assert.deepEqual(await f.store.request(ark, POLICY), {
        kind: "failed",
        reason: "build_failed: 503",
        permanent: false,
      });
      f.advance(retryBackoffMs(POLICY, 1));
      assert.deepEqual(await f.store.request(ark, POLICY), { kind: "enqueue" });
      assert.equal((await f.store.get(ark))?.attempts, 1);

      await f.store.markFailed(ark, "build_failed: 503", { permanent: false });
      f.advance(retryBackoffMs(POLICY, 1));
      assert.equal((await f.store.request(ark, POLICY)).kind, "failed", "the second backoff is twice as long");
      f.advance(retryBackoffMs(POLICY, 2) - retryBackoffMs(POLICY, 1));
      assert.deepEqual(await f.store.request(ark, POLICY), { kind: "enqueue" });
    });

    test("a transient failure is final once maxAttempts is reached", async () => {
      const f = await make();
      const ark = f.ark();
      await f.store.request(ark, POLICY);
      for (let attempt = 1; attempt <= POLICY.maxAttempts; attempt++) {
        await f.store.markFailed(ark, "build_failed: 503", { permanent: false });
        f.advance(retryBackoffMs(POLICY, attempt));
        if (attempt < POLICY.maxAttempts) await f.store.request(ark, POLICY);
      }
      f.advance(retryBackoffMs(POLICY, 10));
      assert.deepEqual(await f.store.request(ark, POLICY), {
        kind: "failed",
        reason: "build_failed: 503",
        permanent: true,
      });
    });

    test("a permanent failure is never re-opened", async () => {
      const f = await make();
      const ark = f.ark();
      await f.store.request(ark, POLICY);
      await f.store.markFailed(ark, "no_metadata", { permanent: true });
      f.advance(retryBackoffMs(POLICY, 10));
      assert.deepEqual(await f.store.request(ark, POLICY), {
        kind: "failed",
        reason: "no_metadata",
        permanent: true,
      });
    });

    test("a stale queued row (expired build) is re-queued with the attempt counted, then expires for good", async () => {
      const f = await make();
      const ark = f.ark();
      await f.store.request(ark, POLICY);
      f.advance(POLICY.queuedStaleAfterMs);
      assert.deepEqual(await f.store.request(ark, POLICY), { kind: "enqueue" });
      assert.equal((await f.store.get(ark))?.attempts, 1);
      f.advance(POLICY.queuedStaleAfterMs);
      assert.deepEqual(await f.store.request(ark, POLICY), { kind: "enqueue" });
      f.advance(POLICY.queuedStaleAfterMs);
      assert.deepEqual(await f.store.request(ark, POLICY), {
        kind: "failed",
        reason: OCR_BACKFILL_EXPIRED,
        permanent: true,
      });
      assert.equal((await f.store.get(ark))?.state, "failed");
    });

    test("markDone / markFailed on an ARK with no row throw", async () => {
      const f = await make();
      const ark = f.ark();
      await assert.rejects(() => f.store.markDone(ark), /no row/);
      await assert.rejects(() => f.store.markFailed(ark, "x", { permanent: false }), /no row/);
    });

    test("counts() reports each state", async () => {
      const f = await make();
      const before = await f.store.counts();
      const [a, b, c] = [f.ark(), f.ark(), f.ark()];
      for (const ark of [a, b, c]) await f.store.request(ark, POLICY);
      await f.store.markDone(b);
      await f.store.markFailed(c, "x", { permanent: true });
      const after = await f.store.counts();
      assert.deepEqual(
        { queued: after.queued - before.queued, done: after.done - before.done, failed: after.failed - before.failed },
        { queued: 1, done: 1, failed: 1 },
      );
    });

    test("an invalid policy is refused", async () => {
      const f = await make();
      for (const bad of [0, -1, 1.5]) {
        await assert.rejects(() => f.store.request(f.ark(), { ...POLICY, retryFailedAfterMs: bad }), /positive integer/);
      }
    });
  });
}

const tag = randomBytes(4).toString("hex");
let seq = 0;
const freshArk = (): string => `ark:/12148/zzbf${tag}${seq++}`;

contract("memory", async () => {
  let t = 1_000_000;
  return {
    store: new MemoryOcrBackfillStore({ now: () => t }),
    advance: (ms) => {
      t += ms;
    },
    ark: freshArk,
  };
});

const PG_URL = process.env.WORKER_TEST_DATABASE_URL;
const pool = PG_URL ? new Pool({ connectionString: PG_URL, statement_timeout: 10_000 }) : null;
let migrated = false;

contract(
  "postgres",
  async () => {
    if (!pool) throw new Error("unreachable: the pg suite is skipped without WORKER_TEST_DATABASE_URL");
    if (!migrated) {
      await new PgDocState(pool).migrate();
      migrated = true;
    }
    let t = Date.parse("2026-01-01T00:00:00Z");
    return {
      store: new PgOcrBackfillStore(pool, { now: () => t }),
      advance: (ms) => {
        t += ms;
      },
      ark: freshArk,
    };
  },
  pool ? {} : { skip: "WORKER_TEST_DATABASE_URL is not set — the Postgres store is not exercised" },
);

if (pool) {
  test("postgres: the CHECK constraint refuses an unknown state", async () => {
    await assert.rejects(
      () => pool.query(`INSERT INTO ${OCR_BACKFILL_TABLE} (ark, state) VALUES ($1, 'bogus')`, [freshArk()]),
      /ocr_quality_backfill_state_check/,
    );
  });

  after(async () => {
    await pool.query(`DELETE FROM ${OCR_BACKFILL_TABLE} WHERE ark LIKE $1`, [`ark:/12148/zzbf${tag}%`]);
    await pool.end();
  });
}

test("validateOcrBackfillPolicy accepts a well-formed policy", () => {
  assert.deepEqual(validateOcrBackfillPolicy(POLICY), POLICY);
});
