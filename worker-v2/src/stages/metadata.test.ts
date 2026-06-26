/**
 * Metadata stage unit tests — the lane router at the head of the pipeline.
 *
 * The MetadataStage reads OAI metadata (S3-cached), classifies a lane, and then:
 *   - text   → recordPlan + fan out N ALTO FolioItems to Q.fetch (no manifest).
 *   - vision → emit ONE ManifestReq to Q.manifest (the manifest stage plans).
 *   - mistral→ emit ONE ManifestReq to Q.manifest.
 *   - skip   → setStatus "skipped"; nothing routed.
 *
 * Harness note: Q.fetch and Q.manifest have no real downstream here, so we attach
 * capturing sinks to both — they drain the message (so `idle()` settles) and record
 * the routed payloads for assertions. A DocRef is seeded onto Q.metadata and the
 * started stage consumes it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryQueue } from "../core/queue-memory.js";
import { MemoryBlobStore } from "../core/blob.js";
import { createMemoryLogger } from "../core/logger.js";
import { MemoryDocState } from "../domain/doc-state-memory.js";
import { keys } from "../domain/keys.js";
import { FETCH_PRIORITY, Q } from "../domain/queues.js";
import type { DocRef, FolioItem, ManifestReq } from "../domain/types.js";
import { FakeBnfClient, type FakeDocSpec } from "../testing/fakes.js";
import { MetadataStage, type MetadataOpts } from "./metadata.js";

type FetchItem = FolioItem & { priority: number };

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
    { mistralEnabled: args.opts?.mistralEnabled ?? false, maxPages: args.opts?.maxPages },
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

// 5. Permanent metadata error → skipped, nothing routed, outcome kind "skip".
test("a permanent metadata error skips the doc and routes nothing", async () => {
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
    metadataFault: { permanent: true, status: 403 },
  });

  const fetched: FetchItem[] = [];
  const manifested: ManifestReq[] = [];
  await q.work<FetchItem>(Q.fetch, async (m) => { fetched.push(m.payload); }, { concurrency: 1 });
  await q.work<ManifestReq>(Q.manifest, async (m) => { manifested.push(m.payload); }, { concurrency: 1 });

  const stage = new MetadataStage(
    { queue: q, blob, log: logger, onOutcome: (e) => events.push({ kind: e.kind }) },
    bnf,
    ds,
    { mistralEnabled: true },
  );
  await stage.start();

  const ref: DocRef = { projectId: "proj-1", docJobId: "doc-1", ark: "ark:/12148/forbidden" };
  await q.send(Q.metadata, ref);
  await q.idle();

  const row = await ds.get(ref.docJobId);
  assert.equal(row?.status, "skipped");
  // The fake throws a generic PermanentBnfError (cause "forbidden") → metadata_unavailable.
  assert.ok(
    row?.skipReason === "metadata_unavailable" || row?.skipReason === "not_digitized",
    `skipReason should be metadata_unavailable or not_digitized, got ${row?.skipReason}`,
  );
  assert.equal(fetched.length, 0);
  assert.equal(manifested.length, 0);

  const metadataEvents = events.filter((e) => e.kind !== undefined);
  assert.ok(metadataEvents.some((e) => e.kind === "skip"), "a skip outcome was dispatched");
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

// 7. Metadata persisted to S3 and reused — a second delivery does not re-call OAI.
test("resolved metadata is persisted to S3 and reused on redelivery", async () => {
  const h = await setup({
    spec: { ark: "ark:/12148/cacheme", ocrAvailable: true, docType: "texte", pageCount: 2 },
  });

  await h.deliver();
  await h.q.idle();

  // Persisted under the metadata key.
  const cached = await h.blob.getJson(keys.metadata(h.ref.ark));
  assert.ok(cached !== null, "metadata JSON persisted to S3 at keys.metadata(ark)");
  assert.equal(h.bnf.calls.metadata, 1, "OAI called once on the first delivery");

  // A second identical delivery reads the S3 cache instead of re-calling OAI.
  await h.deliver();
  await h.q.idle();

  assert.equal(h.bnf.calls.metadata, 1, "metadata call count did not grow — S3 cache reused");
});
