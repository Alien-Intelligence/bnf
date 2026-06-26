/**
 * Full-pipeline integration tests — fake clients, real wiring (buildPipeline),
 * real stages, real queue/blob/doc-state semantics. This is the fake-mode version
 * of the goal's acceptance gate: one doc of EACH lane flows end to end, then 5xx /
 * permanent faults are spiked in to prove retry, terminal failure, fail-ratio, and
 * the observability counters all behave. No network, no BnF quota.
 *
 * The live 1/10/80-doc runs against the real broker are a separate manual gate
 * (they consume the shared 300/min credential — see the run script + README).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPipeline } from "./build.js";
import { MemoryQueue } from "./core/queue-memory.js";
import { MemoryBlobStore } from "./core/blob.js";
import { createMemoryLogger } from "./core/logger.js";
import { MemoryDocState } from "./domain/doc-state-memory.js";
import type { DocStatus } from "./domain/doc-state.js";
import type { DocRef } from "./domain/types.js";
import {
  FakeBnfClient,
  FakeClusterSink,
  FakeDescriber,
  FakeEmbedder,
  FakeOcrEngine,
  type FakeDocSpec,
} from "./testing/fakes.js";

interface Harness {
  queue: MemoryQueue;
  docState: MemoryDocState;
  cluster: FakeClusterSink;
  bnf: FakeBnfClient;
  ocr: FakeOcrEngine;
  events: Array<{ stage: string; kind: string }>;
  seed: (docs: DocRef[]) => Promise<void>;
}

function harness(
  specs: FakeDocSpec[],
  opts: { mistralEnabled?: boolean; ocrFail?: boolean } = {},
): Harness {
  const queue = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const { logger } = createMemoryLogger();
  const docState = new MemoryDocState();
  const cluster = new FakeClusterSink();
  const bnf = new FakeBnfClient();
  for (const s of specs) bnf.add(s);
  const ocr = new FakeOcrEngine(opts.ocrFail ? { fail: true } : {});
  const events: Array<{ stage: string; kind: string }> = [];

  const pipeline = buildPipeline({
    queue,
    blob,
    log: logger,
    bnf,
    docState,
    describer: new FakeDescriber(),
    ocr,
    embedder: new FakeEmbedder(),
    cluster,
    onOutcome: (e) => events.push({ stage: e.stage, kind: e.kind }),
    config: { mistralEnabled: opts.mistralEnabled ?? true, maxPages: 200 },
  });

  return {
    queue,
    docState,
    cluster,
    bnf,
    ocr,
    events,
    seed: async (docs) => {
      await pipeline.start();
      await pipeline.seed(docs);
    },
  };
}

const ref = (n: string): DocRef => ({ projectId: "p1", docJobId: `job-${n}`, ark: `ark:/12148/${n}` });

test("one doc of each lane flows end to end to registration", async () => {
  const h = harness([
    { ark: "ark:/12148/textdoc", ocrAvailable: true, docType: "texte", pageCount: 3 },
    { ark: "ark:/12148/visiondoc", ocrAvailable: false, docType: "estampe", pageCount: 3 },
    { ark: "ark:/12148/mistraldoc", ocrAvailable: false, docType: "texte", pageCount: 3 },
  ]);
  await h.seed([ref("textdoc"), ref("visiondoc"), ref("mistraldoc")]);
  await h.queue.idle();

  const counts = await h.docState.statusCounts();
  assert.equal(counts.done, 3, `expected 3 done, got ${JSON.stringify(counts)}`);
  assert.equal(h.cluster.upserts.length, 3);
  // Text doc fetched ALTO (3), the two image docs fetched images (6) via manifest.
  assert.equal(h.bnf.calls.alto, 3);
  assert.equal(h.bnf.calls.image, 6);
  assert.equal(h.bnf.calls.manifest, 2); // only the image lanes hit the manifest
  assert.equal(h.ocr.submitted.length, 1); // one Mistral batch (the mistral doc)
});

test("transient 5xx on a folio recovers after retries (doc still completes)", async () => {
  const h = harness([
    {
      ark: "ark:/12148/flaky",
      ocrAvailable: true,
      docType: "texte",
      pageCount: 3,
      folioFaults: { 2: { status: 502, transientTimes: 2 } }, // 502 twice, then ok
    },
  ]);
  await h.seed([ref("flaky")]);
  await h.queue.idle();

  const counts = await h.docState.statusCounts();
  assert.equal(counts.done, 1);
  assert.equal(h.cluster.upserts[0]?.pages, 3); // all 3 folios present after recovery
});

test("a doc that loses too many folios trips the fail-ratio → failed", async () => {
  const h = harness([
    {
      ark: "ark:/12148/lossy",
      ocrAvailable: true,
      docType: "texte",
      pageCount: 4,
      folioFaults: {
        1: { alwaysTransient: true, status: 500 },
        2: { alwaysTransient: true, status: 500 },
      }, // 2/4 = 50% lost > 25%
    },
  ]);
  await h.seed([ref("lossy")]);
  await h.queue.idle();

  const counts = await h.docState.statusCounts();
  assert.equal(counts.failed, 1, `expected failed, got ${JSON.stringify(counts)}`);
  assert.equal(h.cluster.upserts.length, 0);
});

test("permanent manifest failure fails the image doc terminally (no retry storm)", async () => {
  const h = harness([
    {
      ark: "ark:/12148/badmanifest",
      ocrAvailable: false,
      docType: "estampe",
      pageCount: 3,
      manifestFault: { permanent: true, status: 500 },
    },
  ]);
  await h.seed([ref("badmanifest")]);
  await h.queue.idle();

  const counts = await h.docState.statusCounts();
  assert.equal(counts.failed, 1);
  assert.equal(h.bnf.calls.manifest, 1); // permanent → exactly one attempt, no storm
});

test("permanent metadata failure (404/forbidden) → skipped, never fetched", async () => {
  const h = harness([
    {
      ark: "ark:/12148/forbidden",
      ocrAvailable: true,
      docType: "texte",
      pageCount: 3,
      metadataFault: { permanent: true, status: 403 },
    },
  ]);
  await h.seed([ref("forbidden")]);
  await h.queue.idle();

  const counts = await h.docState.statusCounts();
  assert.equal(counts.skipped, 1);
  assert.equal(h.bnf.calls.alto, 0);
});

test("doc with no OCR + not an image + paid OCR OFF → skipped", async () => {
  const h = harness(
    [{ ark: "ark:/12148/sanstexte", ocrAvailable: false, docType: "texte", pageCount: 3 }],
    { mistralEnabled: false },
  );
  await h.seed([ref("sanstexte")]);
  await h.queue.idle();

  const counts = await h.docState.statusCounts();
  assert.equal(counts.skipped, 1);
});

test("a failed Mistral batch fails the mistral doc terminally", async () => {
  const h = harness(
    [{ ark: "ark:/12148/ocrfail", ocrAvailable: false, docType: "texte", pageCount: 3 }],
    { mistralEnabled: true, ocrFail: true },
  );
  await h.seed([ref("ocrfail")]);
  await h.queue.idle();

  const counts = await h.docState.statusCounts();
  assert.equal(counts.failed, 1);
  assert.equal(h.cluster.upserts.length, 0);
});

test("observability counters reconcile: done + failed + skipped = total", async () => {
  const h = harness([
    { ark: "ark:/12148/ok1", ocrAvailable: true, docType: "texte", pageCount: 2 },
    { ark: "ark:/12148/ok2", ocrAvailable: false, docType: "carte", pageCount: 2 },
    {
      ark: "ark:/12148/skip1",
      ocrAvailable: true,
      docType: "texte",
      pageCount: 3,
      metadataFault: { permanent: true },
    },
  ]);
  await h.seed([ref("ok1"), ref("ok2"), ref("skip1")]);
  await h.queue.idle();

  const c = await h.docState.statusCounts();
  const terminal = (["done", "failed", "skipped", "excluded"] as DocStatus[]).reduce(
    (n, s) => n + c[s],
    0,
  );
  assert.equal(terminal, 3, `all 3 docs reach a terminal state: ${JSON.stringify(c)}`);
  assert.equal(c.done, 2);
  assert.equal(c.skipped, 1);
});
