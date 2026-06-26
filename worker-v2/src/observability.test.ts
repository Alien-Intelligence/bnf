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

void META;
