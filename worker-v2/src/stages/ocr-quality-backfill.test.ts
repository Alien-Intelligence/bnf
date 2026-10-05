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
import { isDocOcrQuality } from "./ocr-quality.js";
import { OCR_BACKFILL_REASON, type OcrBackfillPolicy } from "../domain/ocr-backfill.js";

/** A policy whose rules never interfere with a single delivery. */
const POLICY_FAST: OcrBackfillPolicy = {
  retryFailedAfterMs: 1,
  maxAttempts: 5,
  startedStaleAfterMs: 1,
  unstartedStaleAfterMs: 1,
};
/** A signal that never aborts. */
const LIVE = new AbortController().signal;

const ARK = "ark:/12148/bpt6k4625753w";

interface Harness {
  q: MemoryQueue;
  blob: MemoryBlobStore;
  bnf: FakeBnfClient;
  store: MemoryOcrBackfillStore;
  /** Rate-gate acquisitions — one per BnF fetch, zero per cache hit. */
  acquires: () => number;
  seed: () => Promise<void>;
  lines: Array<Record<string, unknown>>;
}

async function setup(
  spec: FakeDocSpec,
  opts: { rate?: RateGate; blob?: MemoryBlobStore; rateWaitMs?: number } = {},
): Promise<Harness> {
  const q = new MemoryQueue();
  const blob = opts.blob ?? new MemoryBlobStore();
  const { logger, lines } = createMemoryLogger();
  const bnf = new FakeBnfClient().add(spec);
  const store = new MemoryOcrBackfillStore();
  let acquired = 0;
  const rate: RateGate = opts.rate ?? {
    ratePerMin: 1000,
    acquire: async () => {
      acquired += 1;
    },
  };
  const stage = new OcrQualityBackfillStage({ queue: q, blob, log: logger }, bnf, store, rate, {
    concurrency: 1,
    rateWaitMs: opts.rateWaitMs ?? 1_000,
  });
  await stage.start();
  return {
    q,
    blob,
    bnf,
    store,
    acquires: () => acquired,
    lines,
    seed: async () => {
      // The sync endpoint records the row before sending (one row per ARK).
      await store.request(ARK, POLICY_FAST, LIVE);
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
  assert.equal(row?.permanent, true, "a missing pages artifact never appears by retrying");
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
  assert.equal(row?.permanent, false, "a transient failure stays retryable");
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
  assert.equal(row?.permanent, true);
  const counts = await h.q.counts(Q.ocrQualityBackfill);
  assert.equal(counts.completed, 1);
});

test("a corrupt artifact in S3 is rebuilt, not taken as done", async () => {
  const h = await setup(textSpec());
  await primeTextDoc(h.blob, [1, 2]);
  await h.blob.putJson(keys.ocrQuality(ARK), { v: 1, ark: ARK, lane: "text", folios: "nope" });

  await h.seed();
  await h.q.idle();

  const artifact = await h.blob.getJson<DocOcrQuality>(keys.ocrQuality(ARK));
  assert.deepEqual(artifact?.folios.map((f) => f.ordre), [1, 2], "a valid artifact replaced it");
  assert.equal((await h.store.get(ARK))?.state, "done");
  assert.ok(h.lines.some((l) => l.event === "ocr_quality_artifact_corrupt"));
});

test("a corrupt meta blob → row failed corrupt_metadata, permanent, terminal", async () => {
  const h = await setup(textSpec());
  await primeTextDoc(h.blob, [1, 2]);
  await h.blob.putJson(keys.metadata(ARK), { ark: ARK, ocrAvailable: "yes", raw: {} });

  await h.seed();
  await h.q.idle();

  const row = await h.store.get(ARK);
  assert.equal(row?.state, "failed");
  assert.match(row?.error ?? "", /^corrupt_metadata: /);
  assert.equal(row?.permanent, true);
  assert.equal(h.bnf.calls.alto, 0);
  assert.equal((await h.q.counts(Q.ocrQualityBackfill)).completed, 1);
});

test("a rate-gate wait past its deadline is transient: retried, then failed retryable", async () => {
  let waits = 0;
  const neverGrants: RateGate = {
    ratePerMin: 1,
    acquire: (signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        waits += 1;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  };
  const h = await setup(textSpec(), { rate: neverGrants, rateWaitMs: 5 });
  await primeTextDoc(h.blob, [1, 2]);

  await h.seed();
  await h.q.idle();

  assert.equal(h.bnf.calls.alto, 0, "no BnF call without a token");
  const row = await h.store.get(ARK);
  assert.equal(row?.state, "failed");
  assert.match(row?.error ?? "", /^build_failed: no rate-gate token within 5ms$/);
  assert.equal(row?.permanent, false);
  assert.equal(waits, 4, "one bounded wait per delivery: retried to exhaustion");
  assert.equal((await h.q.counts(Q.ocrQualityBackfill)).completed, 1, "the last attempt records the failure");
});

test("an unclassified error (S3 down) is retried, logged, and ends retryable", async () => {
  class FailingArtifactWrites extends MemoryBlobStore {
    override async putJson(key: string, value: unknown): Promise<void> {
      if (key === keys.ocrQuality(ARK)) throw new Error("S3 down");
      await super.putJson(key, value);
    }
  }
  const h = await setup(textSpec(), { blob: new FailingArtifactWrites() });
  await primeTextDoc(h.blob, [1, 2]);

  await h.seed();
  await h.q.idle();

  const row = await h.store.get(ARK);
  assert.equal(row?.state, "failed");
  assert.match(row?.error ?? "", /^build_failed: .*S3 down/);
  assert.equal(row?.permanent, false);
  assert.ok(h.lines.some((l) => l.event === "ocr_backfill_unclassified_error"));
  assert.equal(h.bnf.calls.alto, 2, "the sidecars written on the first delivery are reused");
});


// ---------------------------------------------------------------------------
// Pass-2: delivery start, terminal rows, artifact contract
// ---------------------------------------------------------------------------

test("a delivery stamps the row's startedAt (the staleness clock) and the built artifact passes isDocOcrQuality", async () => {
  const h = await setup(textSpec());
  await primeTextDoc(h.blob, [1, 2]);
  await h.seed();
  await h.q.idle();
  const row = await h.store.get(ARK);
  assert.ok(row?.startedAt instanceof Date, "the delivery start was recorded");
  assert.equal(isDocOcrQuality(await h.blob.getJson<unknown>(keys.ocrQuality(ARK)), ARK), true);
});

test("a stray delivery for a row no longer queued builds nothing and flips nothing", async () => {
  const h = await setup(textSpec());
  await primeTextDoc(h.blob, [1, 2]);
  await h.store.request(ARK, POLICY_FAST, LIVE);
  await h.store.markFailed(ARK, OCR_BACKFILL_REASON.NO_METADATA, { permanent: true });
  await h.q.send(Q.ocrQualityBackfill, { ark: ARK });
  await h.q.idle();
  assert.equal(h.bnf.calls.alto, 0);
  const row = await h.store.get(ARK);
  assert.deepEqual([row?.state, row?.error], ["failed", OCR_BACKFILL_REASON.NO_METADATA]);
  assert.ok(h.lines.some((l) => l.event === "ocr_backfill_not_queued"));
});

test("a pages blob repeating a folio is corrupt (as strict as the artifact contract) → permanent", async () => {
  const h = await setup(textSpec());
  await primeTextDoc(h.blob, [1, 2]);
  await h.blob.putJson(keys.pages(ARK), [
    { ordre: 1, text: "a" },
    { ordre: 1, text: "b" },
  ]);
  await h.seed();
  await h.q.idle();
  const row = await h.store.get(ARK);
  assert.deepEqual([row?.state, row?.error, row?.permanent], [
    "failed",
    OCR_BACKFILL_REASON.CORRUPT_PAGES_ARTIFACT,
    true,
  ]);
  assert.equal(h.bnf.calls.alto, 0);
});

test("an OcrQualityArtifactError during the build is a PERMANENT build failure naming its code", async () => {
  // The meta blob is there for the stage's own read, then gone when the
  // artifact builder reads it again: the builder raises NO_METADATA.
  class VanishingMeta extends MemoryBlobStore {
    private reads = 0;
    override async getJson<T>(key: string): Promise<T | null> {
      if (key === keys.metadata(ARK) && ++this.reads > 1) return null;
      return super.getJson<T>(key);
    }
  }
  const h = await setup(textSpec(), { blob: new VanishingMeta() });
  await primeTextDoc(h.blob, [1, 2]);
  await h.seed();
  await h.q.idle();
  const row = await h.store.get(ARK);
  assert.equal(row?.state, "failed");
  assert.equal(row?.permanent, true);
  assert.match(row?.error ?? "", /^build_failed: ocr_quality_no_metadata/);
  assert.equal(await h.blob.getJson<unknown>(keys.ocrQuality(ARK)), null, "no artifact written");
});
