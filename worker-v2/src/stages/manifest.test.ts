/**
 * Manifest stage unit tests — image lanes only (vision + mistral).
 *
 * The ManifestStage reads the IIIF manifest (S3-cached, rate-gated in prod),
 * counts canvases, records the plan (pagesExpected = canvas count), and fans out
 * N image FolioItems to Q.fetch. A canvas-less or permanently-failing manifest
 * fails the doc terminally — no retry storm.
 *
 * Harness note: Q.fetch has no real downstream here, so a capturing sink drains it
 * (so `idle()` settles) and records the routed folios. The rate gate is undefined
 * (no pacing in unit tests). A ManifestReq is seeded onto Q.manifest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryQueue } from "../core/queue-memory.js";
import { MemoryBlobStore } from "../core/blob.js";
import { createMemoryLogger } from "../core/logger.js";
import { MemoryDocState } from "../domain/doc-state-memory.js";
import { keys } from "../domain/keys.js";
import { FETCH_PRIORITY, Q } from "../domain/queues.js";
import type { DocMeta, FolioItem, ManifestReq } from "../domain/types.js";
import { FakeBnfClient, type FakeDocSpec } from "../testing/fakes.js";
import { ManifestStage, type ManifestOpts } from "./manifest.js";

type FetchItem = FolioItem & { priority: number };

const META: DocMeta = {
  title: "Une estampe",
  creator: "Anon.",
  date: "1789",
  docType: "estampe",
  subtype: "estampes",
  lang: "fre",
  pageCount: 4,
  ocrAvailable: false,
};

interface Harness {
  q: MemoryQueue;
  blob: MemoryBlobStore;
  ds: MemoryDocState;
  bnf: FakeBnfClient;
  /** Image folios captured off Q.fetch, in arrival order. */
  fetched: FetchItem[];
  events: Array<{ kind: string }>;
  req: ManifestReq;
  /** Push the ManifestReq onto Q.manifest (a fresh delivery). */
  deliver: () => Promise<void>;
}

/** Wire a started ManifestStage over a doc spec + a capturing sink on Q.fetch. */
async function setup(args: {
  spec: FakeDocSpec;
  lane?: ManifestReq["lane"];
  opts?: ManifestOpts;
  req?: ManifestReq;
}): Promise<Harness> {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const { logger } = createMemoryLogger();
  const ds = new MemoryDocState();
  const bnf = new FakeBnfClient();
  bnf.add(args.spec);

  const fetched: FetchItem[] = [];
  const events: Array<{ kind: string }> = [];
  await q.work<FetchItem>(Q.fetch, async (m) => { fetched.push(m.payload); }, { concurrency: 1 });

  const stage = new ManifestStage(
    { queue: q, blob, log: logger, onOutcome: (e) => events.push({ kind: e.kind }) },
    bnf,
    ds,
    undefined, // no rate gate in unit tests
    args.opts ?? {},
  );
  await stage.start();

  const lane = args.lane ?? "vision";
  const req: ManifestReq =
    args.req ?? {
      projectId: "proj-1",
      docJobId: "doc-1",
      ark: args.spec.ark,
      lane,
      meta: { ...META, docType: args.spec.docType, ocrAvailable: args.spec.ocrAvailable },
    };

  // Seed the doc row so doc-state writes have a row to mutate (metadata stage does this in prod).
  await ds.upsertDoc({ docJobId: req.docJobId, projectId: req.projectId, ark: req.ark });

  return {
    q,
    blob,
    ds,
    bnf,
    fetched,
    events,
    req,
    deliver: () => q.send(Q.manifest, req),
  };
}

// 1. Happy path — N canvases → recordPlan + N image folios + manifest persisted.
test("happy path records the plan, fans out image folios, and persists the manifest", async () => {
  const h = await setup({
    spec: { ark: "ark:/12148/estampe", ocrAvailable: false, docType: "estampe", pageCount: 4 },
    lane: "vision",
  });

  await h.deliver();
  await h.q.idle();

  const row = await h.ds.get(h.req.docJobId);
  assert.equal(row?.status, "planned");
  assert.equal(row?.lane, "vision");
  assert.equal(row?.pagesExpected, 4);
  assert.equal(row?.meta?.docType, "estampe");

  assert.equal(h.fetched.length, 4, "four image folios on Q.fetch");
  const ordres = h.fetched.map((f) => f.ordre).sort((a, b) => a - b);
  assert.deepEqual(ordres, [1, 2, 3, 4]);
  for (const f of h.fetched) {
    assert.equal(f.kind, "image");
    assert.equal(f.lane, "vision");
    assert.equal(f.ark, h.req.ark);
    assert.equal(f.docJobId, h.req.docJobId);
    assert.equal(f.priority, FETCH_PRIORITY.vision);
  }

  // Manifest JSON persisted under the manifest key.
  const cached = await h.blob.getJson(keys.manifest(h.req.ark));
  assert.ok(cached !== null, "manifest JSON persisted at keys.manifest(ark)");
});

// Priority is per-lane: a mistral ManifestReq stamps the mistral priority.
test("mistral lane stamps the mistral fetch priority", async () => {
  const h = await setup({
    spec: { ark: "ark:/12148/mistralimg", ocrAvailable: false, docType: "texte", pageCount: 2 },
    lane: "mistral",
  });

  await h.deliver();
  await h.q.idle();

  assert.equal(h.fetched.length, 2);
  for (const f of h.fetched) {
    assert.equal(f.lane, "mistral");
    assert.equal(f.priority, FETCH_PRIORITY.mistral);
  }
});

// 2. Permanent manifest failure → failed terminally, nothing routed, no storm.
test("a permanent manifest failure fails the doc terminally with no retry storm", async () => {
  const h = await setup({
    spec: {
      ark: "ark:/12148/badmanifest",
      ocrAvailable: false,
      docType: "estampe",
      pageCount: 3,
      manifestFault: { permanent: true, status: 500 },
    },
    lane: "vision",
  });

  await h.deliver();
  await h.q.idle();

  const row = await h.ds.get(h.req.docJobId);
  assert.equal(row?.status, "failed");
  assert.match(row?.error ?? "", /manifest_unavailable/);

  assert.equal(h.fetched.length, 0, "nothing routed on a terminal failure");
  assert.equal(h.bnf.calls.manifest, 1, "permanent → exactly one attempt, no storm");

  assert.ok(h.events.some((e) => e.kind === "fail"), "a fail outcome was dispatched");
});

// 3. Zero canvases → failed terminally, nothing routed.
test("a manifest with zero canvases fails the doc terminally", async () => {
  const h = await setup({
    spec: { ark: "ark:/12148/emptymanifest", ocrAvailable: false, docType: "estampe", pageCount: 0 },
    lane: "vision",
  });

  await h.deliver();
  await h.q.idle();

  const row = await h.ds.get(h.req.docJobId);
  assert.equal(row?.status, "failed");
  assert.match(row?.error ?? "", /manifest_no_canvases/);
  assert.equal(h.fetched.length, 0, "nothing routed when there are no canvases");
});

// 4. Manifest S3 cache reused — a second delivery does not re-call getManifest, but
//    still re-fans-out (idempotent: recordPlan + fan-out re-run on redelivery).
test("manifest S3 cache is reused on redelivery while the fan-out stays idempotent", async () => {
  const h = await setup({
    spec: { ark: "ark:/12148/cachemanifest", ocrAvailable: false, docType: "estampe", pageCount: 3 },
    lane: "vision",
  });

  await h.deliver();
  await h.q.idle();

  assert.equal(h.bnf.calls.manifest, 1, "getManifest called once on the first delivery");
  assert.equal(h.fetched.length, 3, "first delivery fans out three folios");

  // A second identical delivery reads the S3-cached manifest (no re-call) but re-fans-out.
  await h.deliver();
  await h.q.idle();

  assert.equal(h.bnf.calls.manifest, 1, "manifest not re-fetched — S3 cache reused");
  assert.equal(h.fetched.length, 6, "fan-out re-runs idempotently (downstream absorbs duplicates)");

  // recordPlan re-run is idempotent: the doc is still planned with the same expectation.
  const row = await h.ds.get(h.req.docJobId);
  assert.equal(row?.status, "planned");
  assert.equal(row?.pagesExpected, 3);
});
