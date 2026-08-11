/**
 * Metadata stage unit tests — the lane router at the head of the pipeline, and
 * (since the 2026-08-11 rate-collapse fix, ai-memories/tech/repos/bnf/
 * ingest-hardening) the owner of metadata resolution itself: manifest-first,
 * OAI-fallback, one fetch per ARK shared with ManifestStage via keys.manifest +
 * ONE RateGate instance.
 *
 * The MetadataStage resolves BnfDocInfo, classifies a lane, and then:
 *   - text   → recordPlan + fan out N ALTO FolioItems to Q.fetch (no manifest
 *              stage — the text lane only needed the page COUNT, already had it).
 *   - vision → emit ONE ManifestReq to Q.manifest (the manifest stage plans).
 *   - mistral→ emit ONE ManifestReq to Q.manifest.
 *   - skip   → setStatus "skipped"; nothing routed.
 *
 * Harness note: Q.fetch and Q.manifest have no real downstream in most tests
 * here, so we attach capturing sinks to both — they drain the message (so
 * `idle()` settles) and record the routed payloads for assertions. A DocRef is
 * seeded onto Q.metadata and the started stage consumes it. The "one fetch per
 * doc across both stages" test below is the one exception: it wires a REAL
 * ManifestStage on Q.manifest instead of a sink, to prove the shared-cache
 * invariant against real wiring, not a mock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryQueue } from "../core/queue-memory.js";
import { MemoryBlobStore } from "../core/blob.js";
import { createMemoryLogger } from "../core/logger.js";
import { MemoryDocState } from "../domain/doc-state-memory.js";
import { keys } from "../domain/keys.js";
import { FETCH_PRIORITY, Q } from "../domain/queues.js";
import type { RateGate } from "../core/types.js";
import type { DocRef, FolioItem, ManifestReq } from "../domain/types.js";
import { FakeBnfClient, type FakeDocSpec } from "../testing/fakes.js";
import { MetadataStage, type MetadataOpts } from "./metadata.js";
import { ManifestStage } from "./manifest.js";

type FetchItem = FolioItem & { priority: number };

/** A RateGate that just counts acquisitions (mirrors core/stage.test.ts). */
class CountingRate implements RateGate {
  readonly ratePerMin = 60;
  acquired = 0;
  async acquire(): Promise<void> {
    this.acquired += 1;
  }
}

interface Harness {
  q: MemoryQueue;
  blob: MemoryBlobStore;
  ds: MemoryDocState;
  bnf: FakeBnfClient;
  /** Payloads captured off Q.fetch / Q.manifest, in arrival order. */
  fetched: FetchItem[];
  manifested: ManifestReq[];
  ref: DocRef;
  /** Push the seeded DocRef onto Q.metadata (a fresh delivery). */
  deliver: () => Promise<void>;
}

/** Wire a started MetadataStage over a doc spec + capturing sinks on the two
 *  output queues. The DocRef is built from the spec's ark. */
async function setup(args: {
  spec: FakeDocSpec;
  opts?: Partial<MetadataOpts>;
  ref?: DocRef;
  rate?: RateGate;
}): Promise<Harness> {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const { logger } = createMemoryLogger();
  const ds = new MemoryDocState();
  const bnf = new FakeBnfClient();
  bnf.add(args.spec);

  const fetched: FetchItem[] = [];
  const manifested: ManifestReq[] = [];
  await q.work<FetchItem>(Q.fetch, async (m) => { fetched.push(m.payload); }, { concurrency: 1 });
  await q.work<ManifestReq>(Q.manifest, async (m) => { manifested.push(m.payload); }, { concurrency: 1 });

  const stage = new MetadataStage(
    { queue: q, blob, log: logger },
    bnf,
    ds,
    args.rate,
    {
      mistralEnabled: args.opts?.mistralEnabled ?? false,
      maxPages: args.opts?.maxPages,
      maxCanvases: args.opts?.maxCanvases,
    },
  );
  await stage.start();

  const ref =
    args.ref ?? { projectId: "proj-1", docJobId: "doc-1", ark: args.spec.ark };

  return {
    q,
    blob,
    ds,
    bnf,
    fetched,
    manifested,
    ref,
    deliver: () => q.send(Q.metadata, ref),
  };
}

// 1. Text lane — OCR available → recordPlan(text) + N ALTO folios on Q.fetch.
test("text lane fans out N ALTO folios and records a text plan", async () => {
  const h = await setup({
    spec: { ark: "ark:/12148/textdoc", ocrAvailable: true, docType: "texte", pageCount: 3 },
  });

  await h.deliver();
  await h.q.idle();

  const row = await h.ds.get(h.ref.docJobId);
  assert.equal(row?.status, "planned");
  assert.equal(row?.lane, "text");
  assert.equal(row?.pagesExpected, 3);

  assert.equal(h.fetched.length, 3, "three ALTO folios on Q.fetch");
  assert.equal(h.manifested.length, 0, "nothing on Q.manifest for the text lane");

  const ordres = h.fetched.map((f) => f.ordre).sort((a, b) => a - b);
  assert.deepEqual(ordres, [1, 2, 3]);
  for (const f of h.fetched) {
    assert.equal(f.kind, "alto");
    assert.equal(f.lane, "text");
    assert.equal(f.ark, h.ref.ark);
    assert.equal(f.docJobId, h.ref.docJobId);
    assert.equal(f.priority, FETCH_PRIORITY.text);
  }
});

// 2. Vision lane — no OCR + visual docType → ONE ManifestReq, no fan-out, no plan yet.
test("vision lane hands off one ManifestReq and does not plan or fetch", async () => {
  const h = await setup({
    spec: { ark: "ark:/12148/visiondoc", ocrAvailable: false, docType: "estampe", pageCount: 5 },
  });

  await h.deliver();
  await h.q.idle();

  assert.equal(h.manifested.length, 1, "one ManifestReq on Q.manifest");
  assert.equal(h.fetched.length, 0, "nothing on Q.fetch — the manifest stage fans out");

  const req = h.manifested[0];
  assert.equal(req?.lane, "vision");
  assert.equal(req?.ark, h.ref.ark);
  assert.equal(req?.docJobId, h.ref.docJobId);
  // meta carried for downstream context.
  assert.equal(req?.meta.docType, "estampe");
  assert.equal(req?.meta.ocrAvailable, false);
  assert.equal(req?.meta.pageCount, 5);

  // The metadata stage does NOT plan an image lane — that's the manifest stage's job.
  const row = await h.ds.get(h.ref.docJobId);
  assert.equal(row?.status, "queued", "still queued; plan is recorded by the manifest stage");
  assert.equal(row?.lane, null);
  assert.equal(row?.pagesExpected, null);
});

// 3. Mistral lane — no OCR + text docType + mistralEnabled → ONE ManifestReq (mistral).
test("mistral lane hands off one ManifestReq when paid OCR is enabled", async () => {
  const h = await setup({
    spec: { ark: "ark:/12148/mistraldoc", ocrAvailable: false, docType: "texte", pageCount: 4 },
    opts: { mistralEnabled: true },
  });

  await h.deliver();
  await h.q.idle();

  assert.equal(h.manifested.length, 1, "one ManifestReq on Q.manifest");
  assert.equal(h.fetched.length, 0, "nothing on Q.fetch");
  assert.equal(h.manifested[0]?.lane, "mistral");
});

// 4. Skip — no OCR + text docType + mistral OFF → skipped, nothing routed.
test("no-OCR text doc with paid OCR off is skipped and nothing is routed", async () => {
  const h = await setup({
    spec: { ark: "ark:/12148/sanstexte", ocrAvailable: false, docType: "texte", pageCount: 3 },
    opts: { mistralEnabled: false },
  });

  await h.deliver();
  await h.q.idle();

  const row = await h.ds.get(h.ref.docJobId);
  assert.equal(row?.status, "skipped");
  assert.equal(row?.skipReason, "no_ocr_and_not_single_image");
  assert.equal(h.fetched.length, 0);
  assert.equal(h.manifested.length, 0);
});

// 5. Permanent manifest AND OAI failure → skipped, nothing routed. A permanent
//    manifest failure ALONE is no longer sufficient (see test further down: it
//    now falls back to OAI) — resolution only fails when BOTH paths are dead.
test("a permanent manifest+OAI failure skips the doc and routes nothing", async () => {
  const events: Array<{ kind: string }> = [];
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const { logger } = createMemoryLogger();
  const ds = new MemoryDocState();
  const bnf = new FakeBnfClient();
  bnf.add({
    ark: "ark:/12148/forbidden",
    ocrAvailable: true,
    docType: "texte",
    pageCount: 3,
    manifestFault: { permanent: true, status: 403 },
    oaiFault: { permanent: true, status: 403 },
  });

  const fetched: FetchItem[] = [];
  const manifested: ManifestReq[] = [];
  await q.work<FetchItem>(Q.fetch, async (m) => { fetched.push(m.payload); }, { concurrency: 1 });
  await q.work<ManifestReq>(Q.manifest, async (m) => { manifested.push(m.payload); }, { concurrency: 1 });

  const stage = new MetadataStage(
    { queue: q, blob, log: logger, onOutcome: (e) => events.push({ kind: e.kind }) },
    bnf,
    ds,
    undefined,
    { mistralEnabled: true },
  );
  await stage.start();

  const ref: DocRef = { projectId: "proj-1", docJobId: "doc-1", ark: "ark:/12148/forbidden" };
  await q.send(Q.metadata, ref);
  await q.idle();

  const row = await ds.get(ref.docJobId);
  assert.equal(row?.status, "skipped");
  assert.equal(row?.skipReason, "metadata_unavailable");
  assert.equal(fetched.length, 0);
  assert.equal(manifested.length, 0);
  assert.equal(bnf.calls.manifest, 1, "manifest tried exactly once — permanent, no retry storm");
  assert.equal(bnf.calls.oai, 1, "OAI fallback tried exactly once after the manifest permanently failed");

  assert.ok(events.some((e) => e.kind === "skip"), "a skip outcome was dispatched");
});

// 5b. Permanent MANIFEST failure alone → OAI fallback reached, doc still resolves.
test("a permanent manifest failure falls back to OAI and the doc still resolves", async () => {
  const h = await setup({
    spec: {
      ark: "ark:/12148/manifestdown",
      ocrAvailable: true,
      docType: "texte",
      pageCount: 3,
      manifestFault: { permanent: true, status: 500 },
    },
  });

  await h.deliver();
  await h.q.idle();

  assert.equal(h.bnf.calls.manifest, 1, "the manifest was tried exactly once (permanent, no storm)");
  assert.equal(h.bnf.calls.oai, 1, "the OAI fallback was reached");

  const row = await h.ds.get(h.ref.docJobId);
  assert.equal(row?.status, "planned", "the doc resolved via OAI instead of being skipped/failed");
  assert.equal(row?.lane, "text");
  assert.equal(row?.pagesExpected, 3);
  assert.equal(h.fetched.length, 3);
});

// 6. maxPages cap — pageCount 500, maxPages 200 → exactly 200 folios, plan 200.
test("maxPages caps the fan-out and the recorded plan", async () => {
  const h = await setup({
    spec: { ark: "ark:/12148/bigdoc", ocrAvailable: true, docType: "texte", pageCount: 500 },
    opts: { maxPages: 200 },
  });

  await h.deliver();
  await h.q.idle();

  assert.equal(h.fetched.length, 200, "fan-out capped at maxPages");
  const row = await h.ds.get(h.ref.docJobId);
  assert.equal(row?.pagesExpected, 200, "recorded plan capped at maxPages");

  const ordres = h.fetched.map((f) => f.ordre).sort((a, b) => a - b);
  assert.equal(ordres[0], 1);
  assert.equal(ordres[ordres.length - 1], 200, "highest ordre is the cap, not the page count");
});

// 7. Resolution cache — metadata AND manifest are both persisted; a redelivery
//    re-resolves from cache and makes no further BnfClient calls.
test("resolved metadata and the manifest it was derived from are persisted to S3 and reused on redelivery", async () => {
  const h = await setup({
    spec: { ark: "ark:/12148/cacheme", ocrAvailable: true, docType: "texte", pageCount: 2 },
  });

  await h.deliver();
  await h.q.idle();

  const cachedMeta = await h.blob.getJson(keys.metadata(h.ref.ark));
  assert.ok(cachedMeta !== null, "metadata JSON persisted at keys.metadata(ark)");
  const cachedManifest = await h.blob.getJson(keys.manifest(h.ref.ark));
  assert.ok(
    cachedManifest !== null,
    "the manifest fetched to resolve metadata is ALSO cached — F2: one fetch serves both consumers",
  );
  assert.equal(h.bnf.calls.manifest, 1, "getManifest called once on the first delivery");
  assert.equal(h.bnf.calls.oai, 0, "the OAI fallback is never reached on the happy path");

  // A second identical delivery reads the S3 metadata cache instead of re-resolving.
  await h.deliver();
  await h.q.idle();

  assert.equal(h.bnf.calls.manifest, 1, "manifest call count did not grow — S3 metadata cache reused");
  assert.equal(h.bnf.calls.oai, 0);
});

// 8. Manifest blob cache HIT (metadata cache MISS) — the shared-cache half of the
//    F1/F2 fix: resolving metadata from an already-cached manifest (e.g. one
//    ManifestStage — or a previous run — already fetched) costs ZERO BnfClient
//    calls and ZERO rate-gate acquires.
test("a manifest blob cache hit resolves metadata with ZERO BnfClient calls and ZERO gate acquires", async () => {
  const rate = new CountingRate();
  const h = await setup({
    spec: { ark: "ark:/12148/warmmanifest", ocrAvailable: true, docType: "texte", pageCount: 2 },
    rate,
  });

  // Prime the manifest cache out-of-band (as ManifestStage or a prior delivery
  // would have) — the metadata cache is deliberately left empty so resolveDocInfo
  // actually runs and has to consult the manifest cache.
  const manifest = await h.bnf.getManifest(h.ref.ark, 200);
  await h.blob.putJson(keys.manifest(h.ref.ark), manifest);
  const manifestCallsAfterPriming = h.bnf.calls.manifest;

  await h.deliver();
  await h.q.idle();

  assert.equal(
    h.bnf.calls.manifest,
    manifestCallsAfterPriming,
    "no additional getManifest call — the manifest blob cache hit",
  );
  assert.equal(h.bnf.calls.oai, 0, "no OAI fallback call");
  assert.equal(rate.acquired, 0, "the manifest rate gate was never touched on a manifest cache hit");

  const row = await h.ds.get(h.ref.docJobId);
  assert.equal(row?.status, "planned", "the doc still resolved and routed correctly");
});

// 9. Manifest blob cache MISS — exactly one gate acquire + one getManifest, and
//    the one-fetch-per-doc invariant holds across BOTH stages: a REAL
//    ManifestStage sharing the same cache/gate makes ZERO further BnfClient
//    calls for the same ARK.
test("manifest cache MISS costs exactly one gate acquire + one getManifest, and ManifestStage reuses it with zero further calls", async () => {
  const rate = new CountingRate();
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const { logger } = createMemoryLogger();
  const ds = new MemoryDocState();
  const bnf = new FakeBnfClient();
  bnf.add({ ark: "ark:/12148/onefetch", ocrAvailable: false, docType: "estampe", pageCount: 4 });

  const fetched: FetchItem[] = [];
  await q.work<FetchItem>(Q.fetch, async (m) => { fetched.push(m.payload); }, { concurrency: 1 });

  const metadataStage = new MetadataStage(
    { queue: q, blob, log: logger },
    bnf,
    ds,
    rate,
    { mistralEnabled: false, maxCanvases: 200 },
  );
  // The SAME rate instance as MetadataStage — the invariant build.ts enforces
  // (one 40/min RateLimiter, wired into both stages).
  const manifestStage = new ManifestStage(
    { queue: q, blob, log: logger },
    bnf,
    ds,
    rate,
    { maxCanvases: 200 },
  );
  await metadataStage.start();
  await manifestStage.start();

  const ref: DocRef = { projectId: "p1", docJobId: "doc-1", ark: "ark:/12148/onefetch" };
  await q.send(Q.metadata, ref);
  await q.idle();

  // MetadataStage resolved via one gated getManifest call, then handed off to
  // Q.manifest, which the REAL ManifestStage drained — and made ZERO further
  // BnfClient calls, because it found the manifest MetadataStage had already
  // cached. That is the F1/F2 invariant this test exists to prove.
  assert.equal(bnf.calls.manifest, 1, "exactly one getManifest call for the whole doc lifecycle");
  assert.equal(bnf.calls.oai, 0);
  // Exactly ONE gate token for the whole doc: MetadataStage's cache-miss fetch.
  // ManifestStage deliberately does NOT use the base class's pre-process `rate`
  // (which would burn a scarce 40/min token before its cache check could run) —
  // it acquires inside process(), only on a manifest-cache MISS, and here the
  // metadata stage has already warmed the cache. Tokens spent == HTTP calls
  // made, which is the invariant that keeps the 40/min budget honest.
  assert.equal(rate.acquired, 1, "one gate token total — the cache-miss fetch; ManifestStage's cache hit costs zero");

  const row = await ds.get(ref.docJobId);
  assert.equal(row?.status, "planned", "ManifestStage successfully planned from the cached manifest");
  assert.equal(row?.pagesExpected, 4);
  assert.equal(fetched.length, 4, "ManifestStage fanned out image folios from the SAME cached manifest");
});
