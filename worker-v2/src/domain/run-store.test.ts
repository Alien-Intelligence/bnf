/**
 * RunStore contract — the terminal-delivery state (pending | emitted | abandoned)
 * and the redeliver reset, run against BOTH implementations. The Postgres suite
 * runs when WORKER_TEST_DATABASE_URL names a Postgres you own (RUN.md) and
 * `npm run test:pg` refuses to pass vacuously without it.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { pgPoolConfig } from "../config.js";
import { PgDocState } from "./doc-state-pg.js";
import { TERMINAL_DELIVERY, terminalDeliveryOf, type IngestRunInput, type RunStore } from "./run.js";
import { MemoryRunStore } from "./run-store-memory.js";
import { PgRunStore } from "./run-store-pg.js";

const input = (): IngestRunInput => ({
  runId: `run-${randomUUID()}`,
  appJobId: "job-1",
  projectId: "p1",
  callbackUrl: "http://127.0.0.1:1/cb",
  callbackSecret: "s3cr3t",
  targetVersionId: "v2",
  totalDocs: 3,
});

/** Drive the run to the emitter's give-up: `failures` failed POSTs, then abandon. */
async function giveUp(store: RunStore, runId: string, failures: number): Promise<void> {
  for (let i = 0; i < failures; i++) {
    assert.equal(await store.markTerminalEmitted(runId), true);
    await store.resetTerminalEmitted(runId);
    await store.incrementTerminalPostFailures(runId);
  }
  await store.markTerminalAbandoned(runId);
}

function contract(name: string, make: () => Promise<RunStore>, opts: { skip?: string }): void {
  describe(`RunStore terminal delivery — ${name}`, { skip: opts.skip }, () => {
    test("a fresh run is pending; a won latch is emitted", async () => {
      const store = await make();
      const i = input();
      await store.create(i);
      assert.equal(terminalDeliveryOf((await store.get(i.runId))!), TERMINAL_DELIVERY.PENDING);
      await store.markTerminalEmitted(i.runId);
      assert.equal(terminalDeliveryOf((await store.get(i.runId))!), TERMINAL_DELIVERY.EMITTED);
    });

    test("the give-up marks the run abandoned (and canceled, so no sweep re-drives it)", async () => {
      const store = await make();
      const i = input();
      await store.create(i);
      await giveUp(store, i.runId, 3);
      const run = (await store.get(i.runId))!;
      assert.equal(terminalDeliveryOf(run), TERMINAL_DELIVERY.ABANDONED);
      assert.equal(run.terminalAbandoned, true);
      assert.equal(run.canceled, true);
      assert.equal(run.terminalPostFailures, 3);
      const swept = (await store.listActiveRuns()).map((r) => r.runId);
      assert.ok(!swept.includes(i.runId), "an abandoned run is not swept");
    });

    test("a user cancel is never abandoned", async () => {
      const store = await make();
      const i = input();
      await store.create(i);
      await store.markCanceled(i.runId);
      const run = (await store.get(i.runId))!;
      assert.equal(run.canceled, true);
      assert.equal(run.terminalAbandoned, false);
      assert.equal(terminalDeliveryOf(run), TERMINAL_DELIVERY.PENDING);
      // A user cancel after many callback failures is still a user cancel.
      const j = input();
      await store.create(j);
      for (let n = 0; n < 5; n++) await store.incrementTerminalPostFailures(j.runId);
      await store.markCanceled(j.runId);
      assert.equal((await store.get(j.runId))!.terminalAbandoned, false);
    });

    test("redeliver re-opens an abandoned run: pending, counter 0, latch released, swept again", async () => {
      const store = await make();
      const i = input();
      await store.create(i);
      await giveUp(store, i.runId, 4);
      assert.equal(await store.redeliverAbandoned(i.runId), true);
      const run = (await store.get(i.runId))!;
      assert.equal(terminalDeliveryOf(run), TERMINAL_DELIVERY.PENDING);
      assert.equal(run.terminalPostFailures, 0);
      assert.equal(run.canceled, false);
      assert.equal(run.terminalEmitted, false);
      assert.ok((await store.listActiveRuns()).some((r) => r.runId === i.runId), "swept again");
      assert.equal(await store.markTerminalEmitted(i.runId), true, "the latch can be won again");
    });

    test("redeliver is refused (and changes nothing) unless the run is abandoned", async () => {
      const store = await make();
      const pending = input();
      await store.create(pending);
      for (let n = 0; n < 2; n++) await store.incrementTerminalPostFailures(pending.runId);
      assert.equal(await store.redeliverAbandoned(pending.runId), false);
      assert.equal((await store.get(pending.runId))!.terminalPostFailures, 2);

      const canceled = input();
      await store.create(canceled);
      await store.markCanceled(canceled.runId);
      assert.equal(await store.redeliverAbandoned(canceled.runId), false);
      assert.equal((await store.get(canceled.runId))!.canceled, true, "a user cancel stays canceled");

      const emitted = input();
      await store.create(emitted);
      await store.markTerminalEmitted(emitted.runId);
      assert.equal(await store.redeliverAbandoned(emitted.runId), false);
      assert.equal((await store.get(emitted.runId))!.terminalEmitted, true);

      assert.equal(await store.redeliverAbandoned("no-such-run"), false);
    });

    test("a second redeliver of the same abandonment is refused", async () => {
      const store = await make();
      const i = input();
      await store.create(i);
      await giveUp(store, i.runId, 1);
      assert.equal(await store.redeliverAbandoned(i.runId), true);
      assert.equal(await store.redeliverAbandoned(i.runId), false);
    });
  });
}

contract("memory", async () => new MemoryRunStore(), {});

const PG_URL = process.env.WORKER_TEST_DATABASE_URL;
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
    return new PgRunStore(pool);
  },
  pool ? {} : { skip: "WORKER_TEST_DATABASE_URL is not set — the Postgres store is not exercised" },
);

if (pool) {
  test("postgres: a row given up before the column existed is reported abandoned after the schema applies; a user cancel stays pending", async () => {
    const store = new PgRunStore(pool);
    await new PgDocState(pool).migrate();
    const legacy = input();
    const userCanceled = input();
    for (const i of [legacy, userCanceled]) await store.create(i);
    // As written by the old code: give-up = canceled + counter, no flag.
    await pool.query(
      `UPDATE sandbox_ingest_v2.ingest_run SET canceled = true, terminal_post_failures = 121 WHERE run_id = $1`,
      [legacy.runId],
    );
    await store.markCanceled(userCanceled.runId);
    assert.equal((await store.get(legacy.runId))!.terminalAbandoned, false, "before the schema re-applies");

    await new PgDocState(pool).migrate();

    assert.equal(terminalDeliveryOf((await store.get(legacy.runId))!), TERMINAL_DELIVERY.ABANDONED);
    assert.equal(terminalDeliveryOf((await store.get(userCanceled.runId))!), TERMINAL_DELIVERY.PENDING);
    // Idempotent, and a redelivered row does not match again.
    assert.equal(await store.redeliverAbandoned(legacy.runId), true);
    await new PgDocState(pool).migrate();
    assert.equal(terminalDeliveryOf((await store.get(legacy.runId))!), TERMINAL_DELIVERY.PENDING);
  });
}

after(async () => {
  await pool?.end();
});
