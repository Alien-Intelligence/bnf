/**
 * FetchStage — the one-FolioResult-per-folio invariant.
 *
 * The fan-in (Monitor) only completes a doc once it has seen exactly
 * `pages_expected` FolioResults. So the fetch stage MUST emit precisely one
 * FolioResult per folio — on success, on a legitimately-empty page, or on a lost
 * folio (permanent error, or a transient error that exhausted its retries). A
 * folio that died silently would hang the whole doc; these tests pin that it never
 * does.
 *
 * Wiring style mirrors monitor.test.ts: a started stage over a MemoryQueue, with a
 * collector worker attached to the stage's output queue (Q.monitor) so `idle()`
 * settles and the emitted pointers are captured for assertions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryQueue } from "../core/queue-memory.js";
import { MemoryBlobStore } from "../core/blob.js";
import { createMemoryLogger } from "../core/logger.js";
import { keys } from "../domain/keys.js";
import { Q } from "../domain/queues.js";
import type { FolioItem, FolioResult } from "../domain/types.js";
import { FakeBnfClient, type FakeDocSpec } from "../testing/fakes.js";
import { FetchStage } from "./fetch.js";

interface Harness {
  q: MemoryQueue;
  blob: MemoryBlobStore;
  bnf: FakeBnfClient;
  /** Every FolioResult the stage emitted onto Q.monitor, in arrival order. */
  emitted: FolioResult[];
  seed: (item: FolioItem) => Promise<void>;
}

const ARK = "ark:/12148/cb12345678x";

/** Wire a started FetchStage over a fake doc + a Q.monitor collector. */
async function setup(spec: FakeDocSpec): Promise<Harness> {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const { logger } = createMemoryLogger();
  const bnf = new FakeBnfClient().add(spec);

  const emitted: FolioResult[] = [];
  // Collector on the stage's output queue: drains (so idle() settles) and records.
  await q.work<FolioResult>(
    Q.monitor,
    async (m) => {
      emitted.push(m.payload);
    },
    { concurrency: 1 },
  );

  const stage = new FetchStage({ queue: q, blob, log: logger }, bnf, undefined);
  await stage.start();

  return { q, blob, bnf, emitted, seed: (item) => q.send(Q.fetch, item) };
}

/** A folio item for the shared ARK. */
function folio(kind: "alto" | "image", ordre: number): FolioItem {
  return {
    docJobId: "doc-1",
    ark: ARK,
    ordre,
    kind,
    lane: kind === "alto" ? "text" : "vision",
  };
}

const altoSpec = (over: Partial<FakeDocSpec> = {}): FakeDocSpec => ({
  ark: ARK,
  ocrAvailable: true,
  docType: "texte",
  pageCount: 10,
  ...over,
});

const imageSpec = (over: Partial<FakeDocSpec> = {}): FakeDocSpec => ({
  ark: ARK,
  ocrAvailable: false,
  docType: "estampe",
  pageCount: 10,
  ...over,
});

// 1. ALTO folio success → one ok/non-empty result; bytes at keys.alto.
test("ALTO folio success emits one ok result and writes bytes", async () => {
  const h = await setup(altoSpec());
  await h.seed(folio("alto", 1));
  await h.q.idle();

  assert.equal(h.emitted.length, 1, "exactly one FolioResult");
  assert.equal(h.emitted[0]?.ok, true);
  assert.equal(h.emitted[0]?.empty, false);
  assert.equal(h.emitted[0]?.ordre, 1);

  const bytes = await h.blob.getBytes(keys.alto(ARK, 1));
  assert.ok(bytes && bytes.length > 0, "ALTO bytes written to keys.alto");
});

// 2. ALTO empty/absent folio → one ok result flagged empty.
test("empty ALTO folio (404) emits one ok+empty result", async () => {
  const h = await setup(altoSpec({ emptyFolios: [1] }));
  await h.seed(folio("alto", 1));
  await h.q.idle();

  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0]?.ok, true);
  assert.equal(h.emitted[0]?.empty, true, "legitimately-empty page is ok, not lost");
});

// 3. Image folio success → one ok result; bytes at keys.image.
test("image folio success emits one ok result and writes image bytes", async () => {
  const h = await setup(imageSpec());
  await h.seed(folio("image", 2));
  await h.q.idle();

  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0]?.ok, true);
  assert.equal(h.emitted[0]?.ordre, 2);

  const bytes = await h.blob.getBytes(keys.image(ARK, 2));
  assert.ok(bytes && bytes.length > 0, "image bytes written to keys.image");
});

// 4. Transient 5xx that recovers → eventually exactly one ok result (proves retry).
test("transient 5xx that recovers emits exactly one ok result after retries", async () => {
  const h = await setup(altoSpec({ folioFaults: { 1: { status: 502, transientTimes: 2 } } }));
  await h.seed(folio("alto", 1));
  await h.q.idle();

  assert.equal(h.emitted.length, 1, "one result after recovery, not one-per-attempt");
  assert.equal(h.emitted[0]?.ok, true);
  // 2 transient throws + 1 success = 3 ALTO calls (the queue redelivered twice).
  assert.equal(h.bnf.calls.alto, 3, "retried twice then succeeded");
});

// 5. Permanent error → one lost result, NO retry storm.
test("permanent error emits one lost result with no retry storm", async () => {
  const h = await setup(altoSpec({ folioFaults: { 1: { permanent: true, status: 403 } } }));
  await h.seed(folio("alto", 1));
  await h.q.idle();

  assert.equal(h.emitted.length, 1, "exactly one FolioResult");
  assert.equal(h.emitted[0]?.ok, false, "permanent → lost");
  assert.equal(h.bnf.calls.alto, 1, "permanent error is not retried");
});

// 6. Always-transient → after exhausting attempts, exactly one lost result (no hang).
test("always-transient folio emits one lost result after exhausting retries", async () => {
  const h = await setup(altoSpec({ folioFaults: { 1: { alwaysTransient: true, status: 500 } } }));
  await h.seed(folio("alto", 1));
  await h.q.idle();

  assert.equal(h.emitted.length, 1, "the invariant: a lost folio is emitted, never dropped");
  assert.equal(h.emitted[0]?.ok, false, "exhausted retries → lost");
  // retry.attempts = 4 → up to 4 deliveries; the last one emits the loss.
  assert.equal(h.bnf.calls.alto, 4, "exhausted exactly the retry budget");
});

// 7. Resume / idempotency: same item twice → process runs once (outcome cache hit),
//    yet a FolioResult is emitted both times (Monitor dedupes per ordre downstream).
test("redelivered folio is an outcome-cache hit: re-emits without re-hitting BnF", async () => {
  const h = await setup(altoSpec());

  await h.seed(folio("alto", 1));
  await h.q.idle();
  assert.equal(h.emitted.length, 1);
  assert.equal(h.bnf.calls.alto, 1);

  // Same folio again — artifactKey already cached → process() is skipped.
  await h.seed(folio("alto", 1));
  await h.q.idle();

  assert.equal(h.emitted.length, 2, "cached outcome is re-dispatched → second FolioResult emitted");
  assert.equal(h.emitted[1]?.ok, true);
  assert.equal(h.bnf.calls.alto, 1, "no new BnF call on the redelivery (cache hit)");
});
