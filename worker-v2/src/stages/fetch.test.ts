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
import type { AltoFolioQuality } from "../bnf/types.js";
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

// --- Image completeness validation (2026-08-13 truncated-cache incident) ----

test("a truncated image response is NEVER cached and the folio retries", async () => {
  const h = await setup(imageSpec({ truncatedFolios: [1] }));
  await h.seed(folio("image", 1));
  await h.q.idle();

  // All 4 attempts fetched (transient → retried), nothing ever cached, and the
  // exhausted folio is emitted as lost so the fan-in still completes.
  assert.equal(h.bnf.calls.image, 4, "every attempt re-fetched");
  assert.equal(await h.blob.getBytes(keys.image(ARK, 1)), null, "truncated bytes never cached");
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0]?.ok, false, "folio reported lost after exhaustion");
});

test("a poisoned cache entry (no EOI) is deleted and re-fetched, then re-cached valid", async () => {
  const h = await setup(imageSpec());
  // Poison the cache the way the 2026-08-13 incident did: header, no EOI.
  await h.blob.putBytes(keys.image(ARK, 2), Buffer.from([0xff, 0xd8, 0x41, 0x42]));

  await h.seed(folio("image", 2));
  await h.q.idle();

  assert.equal(h.bnf.calls.image, 1, "cache was NOT trusted — one fresh fetch");
  const bytes = await h.blob.getBytes(keys.image(ARK, 2));
  assert.ok(bytes && bytes[0] === 0xff && bytes[1] === 0xd8, "re-cached with SOI");
  assert.ok(bytes.subarray(-32).includes(Buffer.from([0xff, 0xd9])), "re-cached with EOI");
  assert.equal(h.emitted[0]?.ok, true, "folio succeeds after self-repair");
});

// --- ALTO quality sidecar (OCR quality per folio, plan D15) ----------------
//
// A text folio is cached only when BOTH keys.alto (the extracted text) AND
// keys.altoQuality (the WC sidecar) exist. The S3 "alto" cache holds plain
// text, not XML, so the word confidences of a pre-release entry cannot be
// recovered without ONE fresh BnF call — these cases pin that it happens
// exactly once, and never again once the sidecar is there.

test("alto: text cached but quality sidecar missing → ONE fetchAltoFolio call, both keys written", async () => {
  const h = await setup(altoSpec());
  // Pre-release cache shape: the extracted text is there, no sidecar.
  await h.blob.putBytes(keys.alto(ARK, 3), Buffer.from("texte déjà en cache", "utf8"));
  assert.equal(await h.blob.has(keys.altoQuality(ARK, 3)), false);

  await h.seed(folio("alto", 3));
  await h.q.idle();

  assert.equal(h.bnf.calls.alto, 1, "a text-only cache entry is a miss: re-fetched once for its WC");
  assert.ok(await h.blob.has(keys.alto(ARK, 3)), "text key present");
  const quality = await h.blob.getJson<AltoFolioQuality>(keys.altoQuality(ARK, 3));
  assert.ok(quality, "quality sidecar written");
  assert.equal(quality.v, 1);
  assert.equal(typeof quality.wordCount, "number");
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0]?.ok, true);
});

test("alto: text AND sidecar cached → zero BnF calls", async () => {
  const h = await setup(altoSpec());
  await h.blob.putBytes(keys.alto(ARK, 4), Buffer.from("texte en cache", "utf8"));
  await h.blob.putJson(keys.altoQuality(ARK, 4), {
    v: 1,
    wordCount: 3,
    scoredWordCount: 3,
    meanWc: 0.93,
  } satisfies AltoFolioQuality);

  await h.seed(folio("alto", 4));
  await h.q.idle();

  assert.equal(h.bnf.calls.alto, 0, "a complete cache entry costs no BnF quota");
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0]?.ok, true);
  assert.equal(h.emitted[0]?.empty, false);
});

test("alto: 404 (empty) folio → sidecar {wordCount 0, meanWc null} and empty:true", async () => {
  const h = await setup(altoSpec({ emptyFolios: [5] }));
  await h.seed(folio("alto", 5));
  await h.q.idle();

  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0]?.empty, true);
  const quality = await h.blob.getJson<AltoFolioQuality>(keys.altoQuality(ARK, 5));
  assert.deepEqual(quality, { v: 1, wordCount: 0, scoredWordCount: 0, meanWc: null });
  const text = await h.blob.getBytes(keys.alto(ARK, 5));
  assert.ok(text !== null && text.length === 0, "empty text still cached so the next run is a hit");
});

test("alto: a fresh fetch writes the sidecar from the parsed WC (mean carried from the client)", async () => {
  const h = await setup(altoSpec({ folioMeanWc: { 6: 0.661 } }));
  await h.seed(folio("alto", 6));
  await h.q.idle();

  const quality = await h.blob.getJson<AltoFolioQuality>(keys.altoQuality(ARK, 6));
  assert.ok(quality);
  assert.equal(quality.meanWc, 0.661);
  assert.ok(quality.wordCount > 0);
  assert.equal(quality.scoredWordCount, quality.wordCount);
});
