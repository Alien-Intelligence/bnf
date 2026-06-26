/**
 * Progress read-model tests — drive a real pipeline run, then assert the report
 * reconciles and exposes failed/skipped (never hides them), and the ETA tracks
 * the BnF fetch backlog + the Mistral tail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildProgress } from "./observability.js";
import { MemoryQueue } from "./core/queue-memory.js";
import { MemoryDocState } from "./domain/doc-state-memory.js";
import { Q } from "./domain/queues.js";
import type { DocMeta } from "./domain/types.js";

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

test("reconciles: done + failed + skipped = total, and surfaces failures", async () => {
  const ds = new MemoryDocState();
  const q = new MemoryQueue();
  for (const [id, status] of [
    ["a", "done"],
    ["b", "done"],
    ["c", "failed"],
    ["d", "skipped"],
  ] as const) {
    await ds.upsertDoc({ docJobId: id, projectId: "p1", ark: `ark:/12148/${id}` });
    await ds.setStatus(id, status);
  }

  const report = await buildProgress(ds, q, { projectId: "p1" });
  assert.equal(report.docsTotal, 4);
  assert.equal(report.docsFinished, 2);
  assert.equal(report.docs.failed, 1);
  assert.equal(report.docs.skipped, 1);
  assert.ok(report.reconciles, "doc totals must reconcile");
});

test("ETA derives from the fetch backlog ÷ rate", async () => {
  const ds = new MemoryDocState();
  const q = new MemoryQueue();
  // Park 600 folios on the fetch queue with no worker → all stay 'queued'.
  await q.sendMany(
    Q.fetch,
    Array.from({ length: 600 }, (_, i) => ({ ordre: i })),
  );

  const report = await buildProgress(ds, q, { fetchRatePerMin: 300 });
  // 600 / 300 * 60 = 120 s, no OCR in flight → no Mistral tail.
  assert.equal(report.stages.fetch?.queued, 600);
  assert.equal(report.etaSeconds, 120);
});

test("ETA adds the one-time Mistral tail while OCR work is in flight", async () => {
  const ds = new MemoryDocState();
  const q = new MemoryQueue();
  await q.sendMany(Q.fetch, [{ ordre: 1 }, { ordre: 2 }, { ordre: 3 }]); // 3 folios
  await q.send(Q.ocrPoll, { batchId: "b1" }); // a batch in flight

  const report = await buildProgress(ds, q, { fetchRatePerMin: 300, mistralTailSeconds: 1500 });
  // ceil(3/300*60)=1 s fetch + 1500 s Mistral tail.
  assert.equal(report.etaSeconds, 1 + 1500);
});

test("paid-OCR spend is surfaced when a budget is configured", async () => {
  const ds = new MemoryDocState();
  const q = new MemoryQueue();
  await ds.upsertDoc({ docJobId: "x", projectId: "p1", ark: "ark:/12148/x" });
  const report = await buildProgress(ds, q, {
    projectId: "p1",
    paidOcr: { spentUsd: 1.5, budgetUsd: 10 },
  });
  assert.deepEqual(report.paidOcr, { spentUsd: 1.5, budgetUsd: 10 });
});

test("stages are run-scoped: one run's card excludes another concurrent run's jobs", async () => {
  const ds = new MemoryDocState();
  const q = new MemoryQueue();
  // Two concurrent runs sharing the pg-boss buckets: A (2 docs), B (1 doc).
  await ds.upsertDoc({ docJobId: "a1", runId: "runA", projectId: "p", ark: "ark:/12148/a1" });
  await ds.upsertDoc({ docJobId: "a2", runId: "runA", projectId: "p", ark: "ark:/12148/a2" });
  await ds.upsertDoc({ docJobId: "b1", runId: "runB", projectId: "p", ark: "ark:/12148/b1" });
  // describe bucket: 2 jobs belong to A, 5 to B.
  await q.sendMany(Q.describe, [{ docJobId: "a1" }, { docJobId: "a2" }]);
  await q.sendMany(Q.describe, Array.from({ length: 5 }, () => ({ docJobId: "b1" })));
  // fetch bucket: 3 folios for A, 30 for B.
  await q.sendMany(Q.fetch, Array.from({ length: 3 }, (_, i) => ({ docJobId: "a1", ordre: i })));
  await q.sendMany(Q.fetch, Array.from({ length: 30 }, (_, i) => ({ docJobId: "b1", ordre: i })));

  const a = await buildProgress(ds, q, { runId: "runA", fetchRatePerMin: 300 });
  // Run A's card sees ONLY run A's bucket jobs — not B's (the live conflation bug).
  assert.equal(a.stages.describe?.queued, 2, "run A sees only its 2 describe jobs");
  assert.equal(a.stages.fetch?.queued, 3, "run A sees only its 3 fetch folios");
  // B's 30 pending fetch folios are "ahead of you" in the shared queue.
  assert.equal(a.foliosAhead, 30);

  const b = await buildProgress(ds, q, { runId: "runB", fetchRatePerMin: 300 });
  assert.equal(b.stages.describe?.queued, 5);
  assert.equal(b.stages.fetch?.queued, 30);
  assert.equal(b.foliosAhead, 3);
});

void META;
