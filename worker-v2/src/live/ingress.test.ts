/**
 * Ingress unit tests — the `POST /ingest` body validation + the run/seed effect,
 * exercised against the memory stores + memory queue (no HTTP, no Postgres). The
 * server.test.ts drives the same logic through the real HTTP layer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryQueue } from "../core/queue-memory.js";
import { MemoryDocState } from "../domain/doc-state-memory.js";
import { MemoryRunStore } from "../domain/run-store-memory.js";
import { Q } from "../domain/queues.js";
import type { DocRef } from "../domain/types.js";
import { createRunAndSeed, parseIngestRequest } from "./ingress.js";

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: "p1",
    targetVersionId: "v2",
    appJobId: "job-1",
    added: [
      { ark: "ark:/12148/a", title: "A", year: 1900, docType: "texte", subtype: null, lang: "fre", source: "Gallica", iiifManifestUrl: null },
      { ark: "ark:/12148/b", title: "B", year: 1901, docType: "texte", subtype: null, lang: "fre", source: "Gallica", iiifManifestUrl: null },
    ],
    removed: ["ark:/12148/old"],
    callbackUrl: "https://app.example/api/internal/ingest/job-1/progress",
    callbackSecret: "deadbeef",
    ...overrides,
  };
}

test("parseIngestRequest accepts a well-formed body and keeps ark, subtype and docType from added", () => {
  const r = parseIngestRequest(validBody());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.docs, [
    { ark: "ark:/12148/a", subtype: null, docType: "texte" },
    { ark: "ark:/12148/b", subtype: null, docType: "texte" },
  ]);
  assert.equal(r.value.projectId, "p1");
  assert.equal(r.value.callbackSecret, "deadbeef");
});

test("parseIngestRequest rejects missing required fields", () => {
  for (const field of ["projectId", "targetVersionId", "appJobId", "callbackUrl", "callbackSecret"]) {
    const r = parseIngestRequest(validBody({ [field]: undefined }));
    assert.equal(r.ok, false, `expected ${field} to be required`);
  }
});

test("parseIngestRequest rejects a non-array added and a doc missing ark", () => {
  assert.equal(parseIngestRequest(validBody({ added: "nope" })).ok, false);
  assert.equal(parseIngestRequest(validBody({ added: [{ title: "no ark" }] })).ok, false);
  assert.equal(parseIngestRequest(null).ok, false);
  assert.equal(parseIngestRequest("string").ok, false);
});

test("parseIngestRequest reads subtype: a string is kept, null and absent become null", () => {
  const r = parseIngestRequest(
    validBody({
      added: [
        { ark: "ark:/12148/a", docType: "texte", subtype: "fascicules" },
        { ark: "ark:/12148/b", docType: "image", subtype: null },
        { ark: "ark:/12148/c", docType: "other" },
      ],
    }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.docs, [
    { ark: "ark:/12148/a", subtype: "fascicules", docType: "texte" },
    { ark: "ark:/12148/b", subtype: null, docType: "image" },
    { ark: "ark:/12148/c", subtype: null, docType: "other" },
  ]);
});

test("parseIngestRequest rejects a non-string or blank subtype with the specific reason", () => {
  const expected = { ok: false, error: "added[0].subtype must be a non-blank string or null" };
  for (const subtype of [3, "", "   "]) {
    const r = parseIngestRequest(validBody({ added: [{ ark: "ark:/12148/a", docType: "texte", subtype }] }));
    assert.deepEqual(r, expected);
  }
});

test("parseIngestRequest requires a non-blank string docType", () => {
  for (const docType of [undefined, null, "", "  ", ["texte"], 3]) {
    const r = parseIngestRequest(
      validBody({ added: [{ ark: "ark:/12148/a", docType: "texte" }, { ark: "ark:/12148/b", docType }] }),
    );
    assert.deepEqual(r, { ok: false, error: "added[1].docType is required" });
  }
});

test("createRunAndSeed puts subtype and docType on the queued DocRefs", async () => {
  const queue = new MemoryQueue();
  const seen: DocRef[] = [];
  await queue.work<DocRef>(Q.metadata, async (m) => { seen.push(m.payload); }, { concurrency: 1 });
  const parsed = parseIngestRequest(
    validBody({ added: [{ ark: "ark:/12148/a", docType: "texte", subtype: "fascicules" }] }),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  await createRunAndSeed(
    { runStore: new MemoryRunStore(), docState: new MemoryDocState(), queue },
    parsed.value,
  );
  await queue.idle();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.subtype, "fascicules");
  assert.equal(seen[0]?.docType, "texte");
});

test("createRunAndSeed creates the run, seeds N metadata messages, returns a runId", async () => {
  const queue = new MemoryQueue();
  const docState = new MemoryDocState();
  const runStore = new MemoryRunStore();

  const parsed = parseIngestRequest(validBody());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const { runId, totalDocs } = await createRunAndSeed({ runStore, docState, queue }, parsed.value);

  assert.equal(typeof runId, "string");
  assert.equal(totalDocs, 2);

  const run = await runStore.get(runId);
  assert.ok(run);
  assert.equal(run?.totalDocs, 2);
  assert.equal(run?.appJobId, "job-1");
  assert.equal(run?.callbackUrl, parsed.value.callbackUrl);
  assert.equal(run?.terminalEmitted, false);

  // Two messages queued onto the metadata bucket (no worker attached → still queued).
  const counts = await queue.counts(Q.metadata);
  assert.equal(counts.queued, 2);

  // Both docs are in the run's scope.
  const scoped = await docState.statusCounts({ runId });
  assert.equal(scoped.queued, 2);
});

test("createRunAndSeed with an empty added → zero-doc run, no metadata messages", async () => {
  const queue = new MemoryQueue();
  const docState = new MemoryDocState();
  const runStore = new MemoryRunStore();

  const parsed = parseIngestRequest(validBody({ added: [] }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const { runId, totalDocs } = await createRunAndSeed({ runStore, docState, queue }, parsed.value);
  assert.equal(totalDocs, 0);
  assert.equal((await queue.counts(Q.metadata)).queued, 0);
  assert.equal((await runStore.get(runId))?.totalDocs, 0);
})

// --- idempotency on appJobId (F19) ------------------------------------------

test("two createRunAndSeed calls with the same appJobId produce ONE run — the second returns the first's runId, seeds nothing again", async () => {
  const queue = new MemoryQueue();
  const docState = new MemoryDocState();
  const runStore = new MemoryRunStore();

  const parsed = parseIngestRequest(validBody());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  // First POST — opens the run and seeds both docs.
  const first = await createRunAndSeed({ runStore, docState, queue }, parsed.value);
  assert.equal(first.totalDocs, 2);

  // Second POST for the SAME appJobId — models an app-side retry after a
  // client timeout on the first request (which may or may not have actually
  // succeeded worker-side). Must NOT open a second run or re-seed.
  const second = await createRunAndSeed({ runStore, docState, queue }, parsed.value);

  assert.equal(second.runId, first.runId, "the retry returns the SAME runId")
  assert.equal(second.totalDocs, first.totalDocs)

  // Only one run row exists for this appJobId, and only the original 2
  // metadata messages were ever queued (no re-seed on the second call).
  const run = await runStore.getByAppJobId("job-1")
  assert.ok(run)
  assert.equal(run?.runId, first.runId)
  assert.equal((await queue.counts(Q.metadata)).queued, 2, "the second call queued nothing new")
})

test("getByAppJobId returns null when no run has been opened for that appJobId", async () => {
  const runStore = new MemoryRunStore();
  assert.equal(await runStore.getByAppJobId("never-seen"), null);
});
