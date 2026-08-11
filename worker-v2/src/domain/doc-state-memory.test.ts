/**
 * MemoryDocState.upsertDocs (F19 batch seeding) — verifies the batch method
 * seeds every ref exactly like N sequential upsertDoc calls would, including
 * idempotency on a repeated docJobId. The pg implementation's chunked
 * multi-row INSERT is exercised indirectly by the ingress/server integration
 * tests against a real worker-dev Postgres; this suite locks the contract
 * both implementations must satisfy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryDocState } from "./doc-state-memory.js";

test("upsertDocs seeds every ref — status counts match a full batch", async () => {
  const docState = new MemoryDocState();
  const refs = Array.from({ length: 10 }, (_, i) => ({
    docJobId: `doc-${i}`,
    projectId: "p1",
    ark: `ark:/12148/x${i}`,
    runId: "run-1",
  }));

  await docState.upsertDocs(refs);

  const counts = await docState.statusCounts({ runId: "run-1" });
  assert.equal(counts.queued, 10);

  for (const ref of refs) {
    const row = await docState.get(ref.docJobId);
    assert.ok(row, `${ref.docJobId} was seeded`);
    assert.equal(row?.ark, ref.ark);
    assert.equal(row?.runId, "run-1");
    assert.equal(row?.status, "queued");
  }
});

test("upsertDocs is idempotent per docJobId — a repeated ref does not clobber recorded state", async () => {
  const docState = new MemoryDocState();
  const ref = { docJobId: "doc-1", projectId: "p1", ark: "ark:/12148/x1", runId: "run-1" };

  await docState.upsertDocs([ref]);
  await docState.recordPlan("doc-1", {
    lane: "text",
    pagesExpected: 3,
    meta: {
      title: null, creator: null, date: null, docType: null,
      subtype: null, lang: null, pageCount: null, ocrAvailable: false,
    },
  });

  // A second seed pass (e.g. a redelivered/retried batch) must not reset the
  // plan already recorded — upsertDoc/upsertDocs only ever CREATE, never overwrite.
  await docState.upsertDocs([ref]);

  const row = await docState.get("doc-1");
  assert.equal(row?.status, "planned", "the recorded plan survived the repeated seed");
  assert.equal(row?.pagesExpected, 3);
});

test("upsertDocs with an empty array is a no-op", async () => {
  const docState = new MemoryDocState();
  await docState.upsertDocs([]);
  const counts = await docState.statusCounts();
  assert.deepEqual(counts, {
    queued: 0, planned: 0, fetching: 0, ready: 0, processing: 0,
    done: 0, failed: 0, skipped: 0, excluded: 0,
  });
});
