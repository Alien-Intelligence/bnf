/**
 * Monitor stage — the pipeline's fan-in / scatter-gather join.
 *
 * Covers: happy fan-in per lane, incomplete docs, fail-ratio, the small-N floor,
 * idempotent redelivery / route-once, out-of-order folio sorting, and empty folios.
 *
 * Harness note: the MemoryQueue's `idle()` only resolves once every queue with
 * messages has a worker that drained it. The Monitor routes DocReady items onto
 * the lane queues, which have no real consumer here — so `setup` attaches a
 * capturing sink to each lane queue. The sink both drains the message (so `idle()`
 * settles) and records the routed payload for assertions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryQueue } from "../core/queue-memory.js";
import { MemoryBlobStore } from "../core/blob.js";
import { createMemoryLogger } from "../core/logger.js";
import { MemoryDocState } from "../domain/doc-state-memory.js";
import { Q, type Lane } from "../domain/queues.js";
import type { DocMeta, DocReady, FolioResult } from "../domain/types.js";
import { MonitorStage, type MonitorOpts } from "./monitor.js";

const LANE_QUEUE: Record<Lane, string> = {
  text: Q.assemble,
  vision: Q.describe,
  mistral: Q.ocrSubmit,
};

const META: DocMeta = {
  title: null,
  creator: null,
  date: null,
  docType: null,
  subtype: null,
  lang: null,
  pageCount: null,
  ocrAvailable: false,
};

interface Harness {
  q: MemoryQueue;
  ds: MemoryDocState;
  docJobId: string;
  ark: string;
  /** DocReady payloads routed onto each lane queue, in arrival order. */
  routed: Record<Lane, DocReady[]>;
  send: (r: Partial<FolioResult> & { ordre: number; ok: boolean }) => Promise<void>;
}

/** Wire a started Monitor over a planned doc + lane-queue sinks, return helpers. */
async function setup(args: {
  lane: Lane;
  pagesExpected: number;
  opts?: MonitorOpts;
  docJobId?: string;
}): Promise<Harness> {
  const q = new MemoryQueue();
  const ds = new MemoryDocState();
  const { logger } = createMemoryLogger();

  const docJobId = args.docJobId ?? "doc-1";
  const projectId = "proj-1";
  const ark = "ark:/12148/cb12345678x";

  const routed: Record<Lane, DocReady[]> = { text: [], vision: [], mistral: [] };
  for (const lane of ["text", "vision", "mistral"] as const) {
    await q.work<DocReady>(
      LANE_QUEUE[lane],
      async (m) => {
        routed[lane].push(m.payload);
      },
      { concurrency: 1 },
    );
  }

  const mon = new MonitorStage(
    { queue: q, blob: new MemoryBlobStore(), log: logger },
    ds,
    args.opts ?? {},
  );

  await ds.upsertDoc({ docJobId, projectId, ark });
  await ds.recordPlan(docJobId, { lane: args.lane, pagesExpected: args.pagesExpected, meta: META });
  await mon.start();

  const send: Harness["send"] = (r) =>
    q.send(Q.monitor, {
      docJobId,
      ark,
      lane: args.lane,
      ordre: r.ordre,
      ok: r.ok,
      ...(r.empty !== undefined ? { empty: r.empty } : {}),
    } satisfies FolioResult);

  return { q, ds, docJobId, ark, routed, send };
}

// 1. Happy fan-in — parametrized over the three lanes.
for (const lane of ["text", "vision", "mistral"] as const) {
  test(`happy fan-in routes one DocReady to the ${lane} lane queue`, async () => {
    const { q, ds, routed, send, docJobId } = await setup({ lane, pagesExpected: 3 });

    await send({ ordre: 1, ok: true });
    await send({ ordre: 2, ok: true });
    await send({ ordre: 3, ok: true });
    await q.idle();

    const row = await ds.get(docJobId);
    assert.equal(row?.status, "ready");

    assert.equal(routed[lane].length, 1, "exactly one DocReady on the lane queue");
    assert.equal(routed[lane][0]?.lane, lane);
    assert.equal(routed[lane][0]?.pagesExpected, 3);

    // No other lane queue received anything.
    for (const other of ["text", "vision", "mistral"] as const) {
      if (other === lane) continue;
      assert.equal(routed[other].length, 0, `nothing on the ${other} queue`);
    }
  });
}

// 2. Incomplete — fewer results than expected → no routing, status unchanged.
test("incomplete doc does not route and stays planned", async () => {
  const { q, ds, routed, send, docJobId } = await setup({ lane: "text", pagesExpected: 3 });

  await send({ ordre: 1, ok: true });
  await send({ ordre: 2, ok: true });
  await q.idle();

  const row = await ds.get(docJobId);
  assert.equal(row?.status, "planned");
  assert.equal(routed.text.length, 0, "nothing routed yet");
});

// 3. Fail-ratio — 3/10 failed (30%) > 25% → doc failed, nothing routed.
test("fail-ratio over threshold fails the doc and routes nothing", async () => {
  const { q, ds, routed, send, docJobId } = await setup({ lane: "text", pagesExpected: 10 });

  for (let ordre = 1; ordre <= 3; ordre++) await send({ ordre, ok: false });
  for (let ordre = 4; ordre <= 10; ordre++) await send({ ordre, ok: true });
  await q.idle();

  const row = await ds.get(docJobId);
  assert.equal(row?.status, "failed");
  assert.match(row?.error ?? "", /page-fail-ratio 3\/10/);

  for (const lane of ["text", "vision", "mistral"] as const) {
    assert.equal(routed[lane].length, 0, `nothing on the ${lane} queue`);
  }
});

// 4. Floor — 2/3 failed (66%) but expected < floor(4) → ratio not applied, routes ready.
test("below the floor the fail-ratio is not applied and the doc routes ready", async () => {
  const { q, ds, routed, send, docJobId } = await setup({ lane: "text", pagesExpected: 3 });

  await send({ ordre: 1, ok: false });
  await send({ ordre: 2, ok: false });
  await send({ ordre: 3, ok: true });
  await q.idle();

  const row = await ds.get(docJobId);
  assert.equal(row?.status, "ready");
  assert.equal(routed.text.length, 1, "one DocReady routed despite high fail ratio");
});

// 5. Idempotent redelivery / route-once (critical).
test("a redelivered folio result neither double-counts nor double-routes", async () => {
  const { q, ds, routed, send, docJobId } = await setup({ lane: "text", pagesExpected: 3 });

  await send({ ordre: 1, ok: true });
  await send({ ordre: 2, ok: true });
  await send({ ordre: 3, ok: true });
  await q.idle();

  const row1 = await ds.get(docJobId);
  assert.equal(row1?.status, "ready");
  assert.equal(row1?.pagesDone, 3);
  assert.equal(routed.text.length, 1);

  // Redeliver an already-recorded ordre (e.g. at-least-once duplicate).
  await send({ ordre: 2, ok: true });
  await q.idle();

  const row2 = await ds.get(docJobId);
  assert.equal(row2?.pagesDone, 3, "counter unchanged on redelivery");
  assert.equal(row2?.pagesFailed, 0);
  assert.equal(routed.text.length, 1, "still exactly one DocReady — claimRoute won only once");
});

// 6. Folio order — out-of-order arrivals produce a sorted folios list.
test("DocReady.folios is sorted regardless of arrival order", async () => {
  const { q, routed, send } = await setup({ lane: "text", pagesExpected: 3 });

  await send({ ordre: 3, ok: true });
  await send({ ordre: 1, ok: true });
  await send({ ordre: 2, ok: true });
  await q.idle();

  assert.equal(routed.text.length, 1);
  assert.deepEqual(routed.text[0]?.folios, [1, 2, 3]);
});

// 7. Empty/absent folios still count as ok (ok:true) and route normally.
test("empty folios count as ok and route normally", async () => {
  const { q, ds, routed, send, docJobId } = await setup({ lane: "text", pagesExpected: 3 });

  await send({ ordre: 1, ok: true, empty: true });
  await send({ ordre: 2, ok: true, empty: true });
  await send({ ordre: 3, ok: true });
  await q.idle();

  const row = await ds.get(docJobId);
  assert.equal(row?.status, "ready");
  assert.equal(row?.pagesFailed, 0, "empty folios are not failures");

  assert.equal(routed.text.length, 1);
  assert.deepEqual(routed.text[0]?.folios, [1, 2, 3], "empty folios still appear as usable pages");
});
