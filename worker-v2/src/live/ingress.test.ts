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

test("parseIngestRequest accepts a well-formed body and keeps only ARKs from added", () => {
  const r = parseIngestRequest(validBody());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.arks, ["ark:/12148/a", "ark:/12148/b"]);
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
});
