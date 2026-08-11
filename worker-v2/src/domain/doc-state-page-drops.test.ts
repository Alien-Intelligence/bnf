/**
 * MemoryDocState.recordPageDrops / listDoneWithDrops (F13 —
 * ai-memories/tech/repos/bnf/ingest-hardening): a doc can finish `done` with
 * ≥1 surviving OCR page while some pages were discarded as unusable. This
 * suite locks the contract both DocStateStore implementations must satisfy —
 * the pg implementation is exercised indirectly via the worker-dev Postgres
 * integration path (same convention as doc-state-memory.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryDocState } from "./doc-state-memory.js";

const META = {
  title: null, creator: null, date: null, docType: null,
  subtype: null, lang: null, pageCount: null, ocrAvailable: false,
};

async function plannedDoneDoc(
  ds: MemoryDocState,
  docJobId: string,
  runId: string,
  pagesExpected: number,
): Promise<void> {
  await ds.upsertDoc({ docJobId, projectId: "p1", ark: `ark:/12148/${docJobId}`, runId });
  await ds.recordPlan(docJobId, { lane: "mistral", pagesExpected, meta: META });
  await ds.setStatus(docJobId, "done");
}

test("recordPageDrops sets pagesDropped/dropReason on the doc row", async () => {
  const ds = new MemoryDocState();
  await plannedDoneDoc(ds, "d1", "run-1", 6);

  await ds.recordPageDrops("d1", { dropped: 5, expected: 6, reason: "hallucination détectée" });

  const row = await ds.get("d1");
  assert.equal(row?.pagesDropped, 5);
  assert.equal(row?.dropReason, "hallucination détectée");
});

test("recordPageDrops clamps dropped to expected defensively", async () => {
  const ds = new MemoryDocState();
  await plannedDoneDoc(ds, "d1", "run-1", 3);

  await ds.recordPageDrops("d1", { dropped: 99, expected: 3, reason: "bug upstream" });

  const row = await ds.get("d1");
  assert.equal(row?.pagesDropped, 3, "never exceeds expected");
});

test("recordPageDrops is idempotent-by-overwrite — a redelivered poll re-records the same tally", async () => {
  const ds = new MemoryDocState();
  await plannedDoneDoc(ds, "d1", "run-1", 6);

  await ds.recordPageDrops("d1", { dropped: 5, expected: 6, reason: "hallucination détectée" });
  await ds.recordPageDrops("d1", { dropped: 5, expected: 6, reason: "hallucination détectée" });

  const row = await ds.get("d1");
  assert.equal(row?.pagesDropped, 5);
});

test("listDoneWithDrops returns only done docs with pagesDropped > 0, scoped to the run, ark-ordered", async () => {
  const ds = new MemoryDocState();
  await plannedDoneDoc(ds, "hollow-b", "run-1", 6);
  await ds.recordPageDrops("hollow-b", { dropped: 5, expected: 6, reason: "hallucination détectée" });

  await plannedDoneDoc(ds, "hollow-a", "run-1", 4);
  await ds.recordPageDrops("hollow-a", { dropped: 1, expected: 4, reason: "pages vides" });

  // A clean done doc (no drops) must not appear.
  await plannedDoneDoc(ds, "clean", "run-1", 3);

  // A doc from another run must not leak in.
  await plannedDoneDoc(ds, "other-run", "run-2", 6);
  await ds.recordPageDrops("other-run", { dropped: 2, expected: 6, reason: "erreurs de transcription" });

  const drops = await ds.listDoneWithDrops("run-1");

  assert.equal(drops.length, 2);
  // Ordered by ark, and ark is derived from docJobId here — "hollow-a" < "hollow-b".
  assert.deepEqual(drops.map((d) => d.ark), ["ark:/12148/hollow-a", "ark:/12148/hollow-b"]);
  const b = drops.find((d) => d.ark === "ark:/12148/hollow-b");
  assert.equal(b?.pagesDropped, 5);
  assert.equal(b?.pagesExpected, 6);
  assert.equal(b?.dropReason, "hallucination détectée");
  assert.equal(b?.lane, "mistral");
});

test("listDoneWithDrops excludes a doc that has drops recorded but is NOT status=done", async () => {
  const ds = new MemoryDocState();
  await ds.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/d1", runId: "run-1" });
  await ds.recordPlan("d1", { lane: "mistral", pagesExpected: 6, meta: META });
  // recordPageDrops can be called before the doc reaches `done` in principle —
  // the query must still gate on status, not just pagesDropped > 0.
  await ds.recordPageDrops("d1", { dropped: 5, expected: 6, reason: "hallucination détectée" });
  await ds.setStatus("d1", "failed", { error: "unrelated failure" });

  const drops = await ds.listDoneWithDrops("run-1");
  assert.deepEqual(drops, []);
});
