/**
 * OcrQualityBackfillStage — builds the per-ARK ocr-quality artifact for a doc
 * that was indexed BEFORE the release (plan D6). Text-lane docs need one fresh
 * BnF ALTO call per page (the "alto" cache holds text, not XML); image lanes
 * need none. Idempotent: the artifact's presence means done; each sidecar's
 * presence means that folio is done, so a redelivery resumes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryQueue } from "../core/queue-memory.js";
import { MemoryBlobStore } from "../core/blob.js";
import { createMemoryLogger } from "../core/logger.js";
import type { RateGate } from "../core/types.js";
import { MemoryOcrBackfillStore } from "../domain/ocr-backfill-memory.js";
import { keys } from "../domain/keys.js";
import { Q } from "../domain/queues.js";
import type { DocOcrQuality, PreparedPage } from "../domain/types.js";
import type { AltoFolioQuality, BnfDocInfo } from "../bnf/types.js";
import { FakeBnfClient, type FakeDocSpec } from "../testing/fakes.js";
import { OcrQualityBackfillStage } from "./ocr-quality-backfill.js";

const ARK = "ark:/12148/bpt6k4625753w";

interface Harness {
  q: MemoryQueue;
  blob: MemoryBlobStore;
  bnf: FakeBnfClient;
  store: MemoryOcrBackfillStore;
  /** Rate-gate acquisitions — one per BnF fetch, zero per cache hit. */
  acquires: () => number;
  seed: () => Promise<void>;
}

async function setup(spec: FakeDocSpec): Promise<Harness> {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const { logger } = createMemoryLogger();
  const bnf = new FakeBnfClient().add(spec);
  const store = new MemoryOcrBackfillStore();
  let acquired = 0;
  const rate: RateGate = {
    ratePerMin: 1000,
    acquire: async () => {
      acquired += 1;
    },
  };
  const stage = new OcrQualityBackfillStage({ queue: q, blob, log: logger }, bnf, store, rate, {
    concurrency: 1,
  });
  await stage.start();
  return {
    q,
    blob,
    bnf,
    store,
    acquires: () => acquired,
    seed: async () => {
      // The sync endpoint records the row before sending (one row per ARK).
      await store.request(ARK, 0);
      await q.send(Q.ocrQualityBackfill, { ark: ARK });
    },
  };
}

const textSpec = (over: Partial<FakeDocSpec> = {}): FakeDocSpec => ({
  ark: ARK,
  ocrAvailable: true,
  docType: "texte",
  pageCount: 2,
  folioMeanWc: { 1: 0.932, 2: 0.661 },
  ...over,
});

function metaBlob(over: Partial<BnfDocInfo> = {}): BnfDocInfo {
  return {
    ark: ARK,
    title: "L'Auto-vélo",
    creator: null,
    date: "1910-07-02",
    docType: "texte",
    subtype: null,
    ocrAvailable: true,
    ocrRate: 0.7821,
    pageCount: 2,
    iiifManifestUrl: null,
    lang: "fre",
    raw: { source: "iiif_manifest", metadata: [] },
    ...over,
  };
}

/** An indexed pre-release text doc: meta + pages + text-only alto cache. */
async function primeTextDoc(blob: MemoryBlobStore, ordres: number[]): Promise<void> {
  await blob.putJson(keys.metadata(ARK), metaBlob());
  const pages: PreparedPage[] = ordres.map((ordre) => ({ ordre, text: `texte f${ordre}` }));
  await blob.putJson(keys.pages(ARK), pages);
  for (const ordre of ordres) {
    await blob.putBytes(keys.alto(ARK, ordre), Buffer.from(`texte f${ordre}`, "utf8"));
  }
}

test("text lane, pages + text present, no sidecars → one BnF call per page, artifact written, row done", async () => {
  const h = await setup(textSpec());
  await primeTextDoc(h.blob, [1, 2]);

  await h.seed();
  await h.q.idle();

  assert.equal(h.bnf.calls.alto, 2, "exactly one ALTO call per prepared page");
  assert.equal(h.acquires(), 2, "each BnF call took a rate token");
  const artifact = await h.blob.getJson<DocOcrQuality>(keys.ocrQuality(ARK));
  assert.ok(artifact);
  assert.equal(artifact.lane, "text");
  assert.equal(artifact.ocrRate, 0.7821);
  assert.deepEqual(
    artifact.folios.map((f) => [f.ordre, f.ocrSource, f.ocrQuality]),
    [[1, "alto", 0.932], [2, "alto", 0.661]],
  );
  assert.equal((await h.store.get(ARK))?.state, "done");
  assert.deepEqual(await h.store.counts(), { queued: 0, done: 1, failed: 0 });
});

test("second delivery → zero BnF calls, zero rate tokens (artifact present = done)", async () => {
  const h = await setup(textSpec());
  await primeTextDoc(h.blob, [1, 2]);
  await h.seed();
  await h.q.idle();
  assert.equal(h.bnf.calls.alto, 2);

  await h.q.send(Q.ocrQualityBackfill, { ark: ARK });
  await h.q.idle();

  assert.equal(h.bnf.calls.alto, 2, "no new BnF call");
  assert.equal(h.acquires(), 2, "no new rate token");
  assert.equal((await h.store.get(ARK))?.state, "done");
});

test("a redelivery after a partial build resumes from the sidecars already written", async () => {
  // Two sidecars exist from an earlier, interrupted build; only the third page
  // costs a BnF call.
  const h = await setup(textSpec({ pageCount: 3, folioMeanWc: { 3: 0.5 } }));
  await primeTextDoc(h.blob, [1, 2, 3]);
  for (const ordre of [1, 2]) {
    await h.blob.putJson(keys.altoQuality(ARK, ordre), {
      v: 1,
      wordCount: 10,
      scoredWordCount: 10,
      meanWc: 0.9,
    } satisfies AltoFolioQuality);
  }

  await h.seed();
  await h.q.idle();

  assert.equal(h.bnf.calls.alto, 1, "only the folio without a sidecar is fetched");
  const artifact = await h.blob.getJson<DocOcrQuality>(keys.ocrQuality(ARK));
  assert.deepEqual(artifact?.folios.map((f) => f.ocrQuality), [0.9, 0.9, 0.5]);
});

test("vision doc (no ocrAvailable, image docType) → artifact without any BnF call", async () => {
  const h = await setup({ ark: ARK, ocrAvailable: false, docType: "estampe", pageCount: 2 });
  await h.blob.putJson(keys.metadata(ARK), metaBlob({ ocrAvailable: false, docType: "estampe", ocrRate: null }));
  await h.blob.putJson(keys.pages(ARK), [
    { ordre: 1, text: "description 1" },
    { ordre: 2, text: "description 2" },
  ] satisfies PreparedPage[]);

  await h.seed();
  await h.q.idle();

  assert.equal(h.bnf.calls.alto, 0);
  assert.equal(h.acquires(), 0);
  const artifact = await h.blob.getJson<DocOcrQuality>(keys.ocrQuality(ARK));
  assert.ok(artifact);
  assert.equal(artifact.lane, "vision");
  assert.equal(artifact.ocrRate, null);
  assert.deepEqual(artifact.folios, [
    { ordre: 1, ocrSource: "vision", ocrQuality: null, wordCount: null },
    { ordre: 2, ocrSource: "vision", ocrQuality: null, wordCount: null },
  ]);
  assert.equal((await h.store.get(ARK))?.state, "done");
});

test("sans_texte text doc → mistral lane artifact (paid OCR is what indexed it), no BnF call", async () => {
  const h = await setup({ ark: ARK, ocrAvailable: false, docType: "texte", pageCount: 1 });
  await h.blob.putJson(keys.metadata(ARK), metaBlob({ ocrAvailable: false, ocrRate: null }));
  await h.blob.putJson(keys.pages(ARK), [{ ordre: 1, text: "ocr mistral" }] satisfies PreparedPage[]);

  await h.seed();
  await h.q.idle();

  assert.equal(h.bnf.calls.alto, 0);
  const artifact = await h.blob.getJson<DocOcrQuality>(keys.ocrQuality(ARK));
  assert.equal(artifact?.lane, "mistral");
  assert.deepEqual(artifact?.folios, [{ ordre: 1, ocrSource: "mistral", ocrQuality: null, wordCount: null }]);
});

test("no pages artifact → row failed no_pages_artifact, terminal (no retry storm)", async () => {
  const h = await setup(textSpec());
  await h.blob.putJson(keys.metadata(ARK), metaBlob());

  await h.seed();
  await h.q.idle();

  assert.equal(h.bnf.calls.alto, 0);
  const row = await h.store.get(ARK);
  assert.equal(row?.state, "failed");
  assert.equal(row?.error, "no_pages_artifact");
  const counts = await h.q.counts(Q.ocrQualityBackfill);
  assert.equal(counts.completed, 1, "terminal fail completes the message");
  assert.equal(counts.failed, 0);
  assert.equal(await h.blob.getJson(keys.ocrQuality(ARK)), null);
});

test("no meta blob → row failed no_metadata, terminal", async () => {
  const h = await setup(textSpec());
  await h.blob.putJson(keys.pages(ARK), [{ ordre: 1, text: "t" }] satisfies PreparedPage[]);

  await h.seed();
  await h.q.idle();

  const row = await h.store.get(ARK);
  assert.equal(row?.state, "failed");
  assert.equal(row?.error, "no_metadata");
  assert.equal(h.bnf.calls.alto, 0);
});

test("transient ALTO error on the last attempt → row failed build_failed, sidecars so far kept", async () => {
  const h = await setup(textSpec({ folioFaults: { 2: { alwaysTransient: true, status: 500 } } }));
  await primeTextDoc(h.blob, [1, 2]);

  await h.seed();
  await h.q.idle();

  // f1 fetched once (then cached), f2 attempted on each of the 4 deliveries.
  assert.equal(h.bnf.calls.alto, 5);
  assert.ok(await h.blob.has(keys.altoQuality(ARK, 1)), "the sidecar written before the failure is kept");
  assert.equal(await h.blob.has(keys.altoQuality(ARK, 2)), false);
  assert.equal(await h.blob.getJson(keys.ocrQuality(ARK)), null, "no partial artifact");
  const row = await h.store.get(ARK);
  assert.equal(row?.state, "failed");
  assert.match(row?.error ?? "", /^build_failed: /);
  assert.equal(row?.attempts, 1);
});

test("permanent BnF error on a folio → row failed immediately, no retry", async () => {
  const h = await setup(textSpec({ folioFaults: { 2: { permanent: true, status: 403 } } }));
  await primeTextDoc(h.blob, [1, 2]);

  await h.seed();
  await h.q.idle();

  assert.equal(h.bnf.calls.alto, 2, "f1 ok, f2 permanent — not retried");
  const row = await h.store.get(ARK);
  assert.equal(row?.state, "failed");
  assert.match(row?.error ?? "", /^build_failed: /);
  const counts = await h.q.counts(Q.ocrQualityBackfill);
  assert.equal(counts.completed, 1);
});
