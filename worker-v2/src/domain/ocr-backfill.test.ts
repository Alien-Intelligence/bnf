/**
 * Contract test for OcrBackfillStore — the SAME cases run against the memory
 * store and the Postgres store, so the two cannot drift (the review found the
 * pg store a silent no-op where the fake threw, and counts() that disagreed).
 *
 * The pg variant runs against a real database: `npm run test:pg` with
 * WORKER_TEST_DATABASE_URL set to a Postgres you own (RUN.md — it applies
 * schema.sql, which is idempotent, and only touches rows it creates under a
 * unique ARK prefix, deleted afterwards). Without it the pg suite is reported
 * as SKIPPED, never silently passed.
 */
import { claimOf } from "../testing/backfill-claims.js";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";

import { MemoryOcrBackfillStore } from "./ocr-backfill-memory.js";
import { OCR_BACKFILL_TABLE, PgOcrBackfillStore } from "./ocr-backfill-pg.js";
import { PgDocState } from "./doc-state-pg.js";
import { pgPoolConfig } from "../config.js";
import {
  OCR_BACKFILL_MARK,
  OCR_BACKFILL_REASON,
  retryBackoffMs,
  validateOcrBackfillPolicy,
  type OcrBackfillPolicy,
  type OcrBackfillStore,
} from "./ocr-backfill.js";

const POLICY: OcrBackfillPolicy = {
  retryFailedAfterMs: 60_000,
  maxAttempts: 3,
  startedStaleAfterMs: 600_000,
  unstartedStaleAfterMs: 6_000_000,
  unsentStaleAfterMs: 300_000,
};

/** A signal that never aborts — the cases that are not about cancellation. */
const LIVE = new AbortController().signal;

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
      assert.equal((await f.store.request(ark, POLICY, LIVE)).kind, "enqueue");
      assert.deepEqual(await f.store.request(ark, POLICY, LIVE), { kind: "queued" });
      assert.equal((await f.store.get(ark))?.attempts, 0);
    });

    test("a done row reaching request lost its artifact: re-opened, the loss counted as an attempt", async () => {
      const f = await make();
      const ark = f.ark();
      await f.store.request(ark, POLICY, LIVE);
      await f.store.markDone(await claimOf(f.store, ark));
      assert.equal((await f.store.request(ark, POLICY, LIVE)).kind, "enqueue");
      const row = await f.store.get(ark);
      assert.equal(row?.state, "queued");
      assert.equal(row?.attempts, 1);
      assert.equal(row?.startedAt, null, "a re-opened build has not started");
    });

    test("an artifact lost maxAttempts times ends as artifact_lost, never loops", async () => {
      const f = await make();
      const ark = f.ark();
      await f.store.request(ark, POLICY, LIVE);
      for (let i = 1; i < POLICY.maxAttempts; i++) {
        await f.store.markDone(await claimOf(f.store, ark));
        assert.equal((await f.store.request(ark, POLICY, LIVE)).kind, "enqueue");
      }
      await f.store.markDone(await claimOf(f.store, ark));
      assert.deepEqual(await f.store.request(ark, POLICY, LIVE), {
        kind: "failed",
        reason: OCR_BACKFILL_REASON.ARTIFACT_LOST,
        permanent: true,
      });
      assert.equal((await f.store.get(ark))?.attempts, POLICY.maxAttempts);
    });

    test("a transient failure is retried after an exponential backoff, keeping its attempt count", async () => {
      const f = await make();
      const ark = f.ark();
      await f.store.request(ark, POLICY, LIVE);
      await f.store.markFailed(await claimOf(f.store, ark), "build_failed: 503", { permanent: false });
      assert.deepEqual(await f.store.request(ark, POLICY, LIVE), {
        kind: "failed",
        reason: "build_failed: 503",
        permanent: false,
      });
      f.advance(retryBackoffMs(POLICY, 1));
      assert.equal((await f.store.request(ark, POLICY, LIVE)).kind, "enqueue");
      assert.equal((await f.store.get(ark))?.attempts, 1);

      await f.store.markFailed(await claimOf(f.store, ark), "build_failed: 503", { permanent: false });
      f.advance(retryBackoffMs(POLICY, 1));
      assert.equal((await f.store.request(ark, POLICY, LIVE)).kind, "failed", "the second backoff is twice as long");
      f.advance(retryBackoffMs(POLICY, 2) - retryBackoffMs(POLICY, 1));
      assert.equal((await f.store.request(ark, POLICY, LIVE)).kind, "enqueue");
    });

    test("a transient failure is final once maxAttempts is reached", async () => {
      const f = await make();
      const ark = f.ark();
      await f.store.request(ark, POLICY, LIVE);
      for (let attempt = 1; attempt <= POLICY.maxAttempts; attempt++) {
        await f.store.markFailed(await claimOf(f.store, ark), "build_failed: 503", { permanent: false });
        f.advance(retryBackoffMs(POLICY, attempt));
        if (attempt < POLICY.maxAttempts) await f.store.request(ark, POLICY, LIVE);
      }
      f.advance(retryBackoffMs(POLICY, 10));
      assert.deepEqual(await f.store.request(ark, POLICY, LIVE), {
        kind: "failed",
        reason: "build_failed: 503",
        permanent: true,
      });
    });

    test("a permanent failure is never re-opened", async () => {
      const f = await make();
      const ark = f.ark();
      await f.store.request(ark, POLICY, LIVE);
      await f.store.markFailed(await claimOf(f.store, ark), "no_metadata", { permanent: true });
      f.advance(retryBackoffMs(POLICY, 10));
      assert.deepEqual(await f.store.request(ark, POLICY, LIVE), {
        kind: "failed",
        reason: "no_metadata",
        permanent: true,
      });
    });

    test("a STARTED queued row goes stale from its delivery start, then expires for good", async () => {
      const f = await make();
      const ark = f.ark();
      await f.store.request(ark, POLICY, LIVE);
      await f.store.markSent(await claimOf(f.store, ark));
      // Long in the backlog: not stale while no delivery started.
      f.advance(POLICY.startedStaleAfterMs * 3);
      assert.deepEqual(await f.store.request(ark, POLICY, LIVE), { kind: "queued" });
      assert.equal(await f.store.markStarted(await claimOf(f.store, ark)), OCR_BACKFILL_MARK.APPLIED);
      f.advance(POLICY.startedStaleAfterMs - 1);
      assert.deepEqual(await f.store.request(ark, POLICY, LIVE), { kind: "queued" }, "a live build");
      f.advance(1);
      assert.equal((await f.store.request(ark, POLICY, LIVE)).kind, "enqueue");
      assert.equal((await f.store.get(ark))?.attempts, 1);
      await f.store.markStarted(await claimOf(f.store, ark));
      f.advance(POLICY.startedStaleAfterMs);
      assert.equal((await f.store.request(ark, POLICY, LIVE)).kind, "enqueue");
      await f.store.markStarted(await claimOf(f.store, ark));
      f.advance(POLICY.startedStaleAfterMs);
      assert.deepEqual(await f.store.request(ark, POLICY, LIVE), {
        kind: "failed",
        reason: OCR_BACKFILL_REASON.EXPIRED,
        permanent: true,
      });
      assert.equal((await f.store.get(ark))?.state, "failed");
    });

    test("a redelivery restarts the staleness clock", async () => {
      const f = await make();
      const ark = f.ark();
      await f.store.request(ark, POLICY, LIVE);
      await f.store.markStarted(await claimOf(f.store, ark));
      f.advance(POLICY.startedStaleAfterMs - 1);
      await f.store.markStarted(await claimOf(f.store, ark)); // the queue's retry delivered it again
      f.advance(POLICY.startedStaleAfterMs - 1);
      assert.deepEqual(await f.store.request(ark, POLICY, LIVE), { kind: "queued" });
    });

    test("a sent but never-started queued row is stale only past the queue's own retention", async () => {
      const f = await make();
      const ark = f.ark();
      await f.store.request(ark, POLICY, LIVE);
      await f.store.markSent(await claimOf(f.store, ark));
      f.advance(POLICY.unstartedStaleAfterMs - 1);
      assert.deepEqual(await f.store.request(ark, POLICY, LIVE), { kind: "queued" });
      f.advance(1);
      assert.equal((await f.store.request(ark, POLICY, LIVE)).kind, "enqueue");
      assert.equal((await f.store.get(ark))?.attempts, 1);
    });

    test("terminal rows stay terminal: a late mark changes nothing and says not_queued", async () => {
      const f = await make();
      const done = f.ark();
      await f.store.request(done, POLICY, LIVE);
      assert.equal(await f.store.markDone(await claimOf(f.store, done)), OCR_BACKFILL_MARK.APPLIED);
      assert.equal(await f.store.markFailed(await claimOf(f.store, done), "late", { permanent: true }), OCR_BACKFILL_MARK.NOT_QUEUED);
      assert.equal(await f.store.markStarted(await claimOf(f.store, done)), OCR_BACKFILL_MARK.NOT_QUEUED);
      const doneRow = await f.store.get(done);
      assert.equal(doneRow?.state, "done");
      assert.equal(doneRow?.attempts, 0);

      const failed = f.ark();
      await f.store.request(failed, POLICY, LIVE);
      await f.store.markFailed(await claimOf(f.store, failed), "no_metadata", { permanent: true });
      assert.equal(await f.store.markDone(await claimOf(f.store, failed)), OCR_BACKFILL_MARK.NOT_QUEUED);
      assert.equal(await f.store.markFailed(await claimOf(f.store, failed), "again", { permanent: false }), OCR_BACKFILL_MARK.NOT_QUEUED);
      const failedRow = await f.store.get(failed);
      assert.deepEqual([failedRow?.state, failedRow?.error, failedRow?.attempts], ["failed", "no_metadata", 1]);
    });

    test("concurrent requests for one ARK: exactly one wins the build", async () => {
      const f = await make();
      const ark = f.ark();
      const results = await Promise.all(Array.from({ length: 6 }, () => f.store.request(ark, POLICY, LIVE)));
      assert.equal(results.filter((r) => r.kind === "enqueue").length, 1);
      assert.equal(results.filter((r) => r.kind === "queued").length, 5);
    });

    test("an aborted signal stops request before any row is written", async () => {
      const f = await make();
      const ark = f.ark();
      const controller = new AbortController();
      controller.abort(new Error("deadline"));
      await assert.rejects(() => f.store.request(ark, POLICY, controller.signal), /deadline/);
      assert.equal(await f.store.get(ark), null);
    });

    test("markDone / markFailed on an ARK with no row throw", async () => {
      const f = await make();
      const ark = f.ark();
      const none = { ark, generation: 1 };
      await assert.rejects(() => f.store.markDone(none), /no row/);
      await assert.rejects(() => f.store.markFailed(none, "x", { permanent: false }), /no row/);
      await assert.rejects(() => f.store.markStarted(none), /no row/);
      await assert.rejects(() => f.store.markSent(none), /no row/);
    });

    test("a superseded delivery can never mark the row its re-open created", async () => {
      const f = await make();
      const ark = f.ark();
      const first = await f.store.request(ark, POLICY, LIVE);
      assert.equal(first.kind, "enqueue");
      const a = { ark, generation: first.kind === "enqueue" ? first.generation : -1 };
      await f.store.markSent(a);
      await f.store.markStarted(a);
      f.advance(POLICY.startedStaleAfterMs); // A looks expired: the row is re-opened
      const second = await f.store.request(ark, POLICY, LIVE);
      assert.equal(second.kind, "enqueue");
      const b = { ark, generation: second.kind === "enqueue" ? second.generation : -1 };
      assert.notEqual(a.generation, b.generation);
      // The late delivery A marks nothing…
      assert.equal(await f.store.markFailed(a, "late", { permanent: true }), OCR_BACKFILL_MARK.NOT_QUEUED);
      assert.equal(await f.store.markDone(a), OCR_BACKFILL_MARK.NOT_QUEUED);
      assert.equal(await f.store.markStarted(a), OCR_BACKFILL_MARK.NOT_QUEUED);
      // …and B builds and finishes.
      assert.equal(await f.store.markStarted(b), OCR_BACKFILL_MARK.APPLIED);
      assert.equal(await f.store.markDone(b), OCR_BACKFILL_MARK.APPLIED);
      assert.equal((await f.store.get(ark))?.state, "done");
    });

    test("a claim whose send was never confirmed is re-opened within minutes, not after the backlog rule", async () => {
      const f = await make();
      const ark = f.ark();
      await f.store.request(ark, POLICY, LIVE); // send and release both failed: no markSent, no markFailed
      f.advance(POLICY.unsentStaleAfterMs - 1);
      assert.deepEqual(await f.store.request(ark, POLICY, LIVE), { kind: "queued" });
      f.advance(1);
      const reopened = await f.store.request(ark, POLICY, LIVE);
      assert.equal(reopened.kind, "enqueue");
      assert.equal((await f.store.get(ark))?.attempts, 1);
    });

    test("a confirmed send waits by the backlog rule", async () => {
      const f = await make();
      const ark = f.ark();
      await f.store.request(ark, POLICY, LIVE);
      assert.equal(await f.store.markSent(await claimOf(f.store, ark)), OCR_BACKFILL_MARK.APPLIED);
      f.advance(POLICY.unsentStaleAfterMs * 2);
      assert.deepEqual(await f.store.request(ark, POLICY, LIVE), { kind: "queued" });
    });

    test("counts() reports each state", async () => {
      const f = await make();
      const before = await f.store.counts();
      const [a, b, c] = [f.ark(), f.ark(), f.ark()];
      for (const ark of [a, b, c]) await f.store.request(ark, POLICY, LIVE);
      await f.store.markDone(await claimOf(f.store, b));
      await f.store.markFailed(await claimOf(f.store, c), "x", { permanent: true });
      const after = await f.store.counts();
      assert.deepEqual(
        { queued: after.queued - before.queued, done: after.done - before.done, failed: after.failed - before.failed },
        { queued: 1, done: 1, failed: 1 },
      );
    });

    test("an invalid policy is refused", async () => {
      const f = await make();
      for (const bad of [0, -1, 1.5]) {
        await assert.rejects(() => f.store.request(f.ark(), { ...POLICY, retryFailedAfterMs: bad }, LIVE), /positive integer/);
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
// `npm run test:pg` sets WORKER_TEST_REQUIRE_PG: there, a missing URL is an
// error, never a vacuous pass of a skipped suite.
if (process.env.WORKER_TEST_REQUIRE_PG === "1" && !PG_URL) {
  throw new Error("npm run test:pg needs WORKER_TEST_DATABASE_URL (RUN.md)");
}
const pool = PG_URL ? new Pool(pgPoolConfig(PG_URL)) : null;
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

  test("postgres: a failed row without a reason, and negative attempts, are refused", async () => {
    await assert.rejects(
      () => pool.query(`INSERT INTO ${OCR_BACKFILL_TABLE} (ark, state) VALUES ($1, 'failed')`, [freshArk()]),
      /ocr_quality_backfill_failed_reason_check/,
    );
    await assert.rejects(
      () =>
        pool.query(`INSERT INTO ${OCR_BACKFILL_TABLE} (ark, state, attempts) VALUES ($1, 'queued', -1)`, [
          freshArk(),
        ]),
      /ocr_quality_backfill_attempts_check/,
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
