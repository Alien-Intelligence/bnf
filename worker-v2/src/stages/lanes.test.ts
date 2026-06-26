/**
 * Back-half lane stages — unit tests.
 *
 * The Monitor (monitor.test.ts) and the full pipeline (integration.test.ts) are
 * covered elsewhere. This file exercises each back-half stage in isolation:
 * assemble / describe / ocr-submit / ocr-poll / embed / register. Each stage is
 * built with a MemoryQueue + MemoryBlobStore + memory logger + the relevant fake
 * + MemoryDocState, with the doc-state row pre-set to a sane post-Monitor state
 * (upsertDoc → recordPlan → claimRoute("ready")). Any S3 artifacts the stage
 * reads are pre-populated; a collector drains the output queue so `idle()` settles.
 *
 * Style mirrors monitor.test.ts (capturing sink on the output queue, await idle).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryQueue } from "../core/queue-memory.js";
import { MemoryBlobStore } from "../core/blob.js";
import { createMemoryLogger } from "../core/logger.js";
import type { StageDeps } from "../core/stage.js";
import { MemoryDocState } from "../domain/doc-state-memory.js";
import type { Lane } from "../domain/queues.js";
import { Q } from "../domain/queues.js";
import { keys } from "../domain/keys.js";
import type {
  DocMeta,
  DocReady,
  EmbeddedDoc,
  OcrBatchRef,
  PreparedDoc,
  PreparedPage,
} from "../domain/types.js";
import type { Describer, Embedder } from "../ports.js";
import {
  FakeClusterSink,
  FakeDescriber,
  FakeEmbedder,
  FakeOcrEngine,
} from "../testing/fakes.js";

import { AssembleStage } from "./assemble.js";
import { DescribeStage } from "./describe.js";
import { OcrSubmitStage } from "./ocr-submit.js";
import { OcrPollStage } from "./ocr-poll.js";
import { EmbedStage } from "./embed.js";
import { RegisterStage } from "./register.js";

// ── shared fixtures ─────────────────────────────────────────────────────────

const ARK = "ark:/12148/cb12345678x";
const PROJECT_ID = "proj-1";
const DOC_JOB_ID = "doc-1";

/** Full DocMeta (every field set) — these are the inter-stage contracts. */
const META: DocMeta = {
  title: "Le Petit Journal",
  creator: "BnF",
  date: "1900",
  docType: "texte",
  subtype: "fascicule",
  lang: "fre",
  pageCount: 3,
  ocrAvailable: true,
};

function deps(q: MemoryQueue, blob: MemoryBlobStore): StageDeps {
  const { logger } = createMemoryLogger();
  return { queue: q, blob, log: logger };
}

/** Seed a doc-state row to the post-Monitor "ready" state (the state these
 *  stages expect: planned → claimed ready). */
async function readyRow(ds: MemoryDocState, lane: Lane, pagesExpected: number): Promise<void> {
  await ds.upsertDoc({ docJobId: DOC_JOB_ID, projectId: PROJECT_ID, ark: ARK });
  await ds.recordPlan(DOC_JOB_ID, { lane, pagesExpected, meta: META });
  const won = await ds.claimRoute(DOC_JOB_ID, "ready");
  assert.equal(won, true, "claimRoute(ready) must win on a freshly planned row");
}

function docReady(lane: Lane, folios: number[]): DocReady {
  return {
    projectId: PROJECT_ID,
    docJobId: DOC_JOB_ID,
    ark: ARK,
    lane,
    pagesExpected: folios.length,
    meta: META,
    folios,
  };
}

/** Attach a collector sink to `queue`; returns the array it fills, in order. */
async function collect<T>(q: MemoryQueue, queue: string): Promise<T[]> {
  const out: T[] = [];
  await q.work<T>(
    queue,
    async (m) => {
      out.push(m.payload);
    },
    { concurrency: 1 },
  );
  return out;
}

// ── assemble (Q.assemble → Q.embed) ──────────────────────────────────────────

test("assemble: emits one PreparedDoc with pages in folio order, lane text", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  await readyRow(ds, "text", 3);

  // ALTO bytes for folios 1,2,3 (pre-populated as the Monitor would have left them).
  for (const ordre of [1, 2, 3]) {
    await blob.putBytes(keys.alto(ARK, ordre), Buffer.from(`alto text f${ordre}`, "utf8"));
  }

  const emitted = await collect<PreparedDoc>(q, Q.embed);
  const stage = new AssembleStage(deps(q, blob), ds);
  await stage.start();

  await q.send(Q.assemble, docReady("text", [1, 2, 3]));
  await q.idle();

  assert.equal(emitted.length, 1, "exactly one PreparedDoc emitted");
  const doc = emitted[0];
  assert.ok(doc);
  assert.equal(doc.lane, "text");
  assert.equal(doc.ark, ARK);
  assert.deepEqual(doc.pages.map((p) => p.ordre), [1, 2, 3], "pages in folio order");
  assert.equal(doc.pages[0]?.text, "alto text f1");

  // Pages persisted at keys.pages.
  const persisted = await blob.getJson<PreparedPage[]>(keys.pages(ARK));
  assert.ok(persisted);
  assert.equal(persisted.length, 3);
  assert.deepEqual(persisted.map((p) => p.ordre), [1, 2, 3]);
});

test("assemble: drops empty/missing ALTO folios", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  await readyRow(ds, "text", 3);

  // Folio 1 has text; folio 2 is empty (whitespace only); folio 3 is missing in S3.
  await blob.putBytes(keys.alto(ARK, 1), Buffer.from("real text", "utf8"));
  await blob.putBytes(keys.alto(ARK, 2), Buffer.from("   \n  ", "utf8"));
  // (no key for folio 3)

  const emitted = await collect<PreparedDoc>(q, Q.embed);
  const stage = new AssembleStage(deps(q, blob), ds);
  await stage.start();

  await q.send(Q.assemble, docReady("text", [1, 2, 3]));
  await q.idle();

  assert.equal(emitted.length, 1);
  const doc = emitted[0];
  assert.ok(doc);
  assert.deepEqual(doc.pages.map((p) => p.ordre), [1], "only the non-empty, present folio survives");
});

test("assemble: no folio has text → terminal fail + doc-state failed", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  await readyRow(ds, "text", 2);

  // Both folios present but empty → nothing assembles.
  await blob.putBytes(keys.alto(ARK, 1), Buffer.from("", "utf8"));
  await blob.putBytes(keys.alto(ARK, 2), Buffer.from("  ", "utf8"));

  const emitted = await collect<PreparedDoc>(q, Q.embed);
  const stage = new AssembleStage(deps(q, blob), ds);
  await stage.start();

  await q.send(Q.assemble, docReady("text", [1, 2]));
  await q.idle();

  assert.equal(emitted.length, 0, "terminal fail emits nothing downstream");
  const row = await ds.get(DOC_JOB_ID);
  assert.equal(row?.status, "failed");
  assert.equal(row?.error, "assemble_no_text");

  // Terminal fail is swallowed → the input message completes, never re-queues.
  const counts = await q.counts(Q.assemble);
  assert.equal(counts.failed, 0, "terminal fail completes the message, no queue-level failure");
  assert.equal(counts.completed, 1);
});

// ── describe (Q.describe → Q.embed) ───────────────────────────────────────────

test("describe: emits PreparedDoc (vision) with one page per image folio", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  await readyRow(ds, "vision", 3);

  for (const ordre of [1, 2, 3]) {
    await blob.putBytes(keys.image(ARK, ordre), Buffer.from(`IMG f${ordre}`));
  }

  const emitted = await collect<PreparedDoc>(q, Q.embed);
  const stage = new DescribeStage(deps(q, blob), new FakeDescriber(), ds, undefined);
  await stage.start();

  await q.send(Q.describe, docReady("vision", [1, 2, 3]));
  await q.idle();

  assert.equal(emitted.length, 1);
  const doc = emitted[0];
  assert.ok(doc);
  assert.equal(doc.lane, "vision");
  assert.deepEqual(doc.pages.map((p) => p.ordre), [1, 2, 3]);
  assert.equal(doc.pages[0]?.text, `Description of ${ARK} folio 1`);

  const persisted = await blob.getJson<PreparedPage[]>(keys.pages(ARK));
  assert.ok(persisted);
  assert.equal(persisted.length, 3);
});

test("describe: a folio missing in S3 is skipped, others survive", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  await readyRow(ds, "vision", 3);

  // Folio 2 image is absent.
  await blob.putBytes(keys.image(ARK, 1), Buffer.from("IMG f1"));
  await blob.putBytes(keys.image(ARK, 3), Buffer.from("IMG f3"));

  const emitted = await collect<PreparedDoc>(q, Q.embed);
  const stage = new DescribeStage(deps(q, blob), new FakeDescriber(), ds, undefined);
  await stage.start();

  await q.send(Q.describe, docReady("vision", [1, 2, 3]));
  await q.idle();

  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0]?.pages.map((p) => p.ordre), [1, 3], "missing folio dropped");
});

test("describe: a Describer that throws on one folio drops it, others survive", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  await readyRow(ds, "vision", 3);

  for (const ordre of [1, 2, 3]) {
    await blob.putBytes(keys.image(ARK, ordre), Buffer.from(`IMG f${ordre}`));
  }

  const flaky: Describer = {
    async describe(input) {
      if (input.ordre === 2) throw new Error("vision provider 500");
      return `desc ${input.ordre}`;
    },
  };

  const emitted = await collect<PreparedDoc>(q, Q.embed);
  const stage = new DescribeStage(deps(q, blob), flaky, ds, undefined);
  await stage.start();

  await q.send(Q.describe, docReady("vision", [1, 2, 3]));
  await q.idle();

  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0]?.pages.map((p) => p.ordre), [1, 3], "throwing folio dropped, doc survives");
});

// ── ocr-submit (Q.ocrSubmit → Q.ocrPoll) ──────────────────────────────────────

test("ocr-submit: submits once, persists batch handle, emits OcrBatchRef", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const ocr = new FakeOcrEngine();
  await readyRow(ds, "mistral", 3);

  for (const ordre of [1, 2, 3]) {
    await blob.putBytes(keys.image(ARK, ordre), Buffer.from(`IMG f${ordre}`));
  }

  const emitted = await collect<OcrBatchRef>(q, Q.ocrPoll);
  const stage = new OcrSubmitStage(deps(q, blob), ocr, ds);
  await stage.start();

  await q.send(Q.ocrSubmit, docReady("mistral", [1, 2, 3]));
  await q.idle();

  assert.equal(ocr.submitted.length, 1, "submitBatch called exactly once");
  assert.equal(emitted.length, 1);
  const ref = emitted[0];
  assert.ok(ref);
  assert.equal(ref.lane, "mistral");
  assert.equal(ref.batchId, `batch-${ARK}`);
  assert.deepEqual(ref.folios, [1, 2, 3]);
  assert.equal(ref.pollAttempt, 0);

  // Batch handle persisted at keys.ocrBatch.
  const handle = await blob.getJson<{ batchId: string; folios: number[] }>(keys.ocrBatch(ARK));
  assert.ok(handle);
  assert.equal(handle.batchId, `batch-${ARK}`);
  assert.deepEqual(handle.folios, [1, 2, 3]);
});

test("ocr-submit: re-delivery does NOT re-submit but still emits (dedup path)", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const ocr = new FakeOcrEngine();
  await readyRow(ds, "mistral", 2);

  for (const ordre of [1, 2]) {
    await blob.putBytes(keys.image(ARK, ordre), Buffer.from(`IMG f${ordre}`));
  }

  const emitted = await collect<OcrBatchRef>(q, Q.ocrPoll);
  const stage = new OcrSubmitStage(deps(q, blob), ocr, ds);
  await stage.start();

  await q.send(Q.ocrSubmit, docReady("mistral", [1, 2]));
  await q.idle();
  // Second, independent delivery of the same doc (at-least-once duplicate).
  await q.send(Q.ocrSubmit, docReady("mistral", [1, 2]));
  await q.idle();

  assert.equal(ocr.submitted.length, 1, "submitBatch stays at one — paid op not repeated");
  assert.equal(emitted.length, 2, "both deliveries still emit the poll pointer");
  assert.equal(emitted[1]?.batchId, `batch-${ARK}`, "dedup reuses the existing batch id");
});

test("ocr-submit: no images in S3 → terminal fail + doc-state failed", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const ocr = new FakeOcrEngine();
  await readyRow(ds, "mistral", 2);
  // No image artifacts pre-populated.

  const emitted = await collect<OcrBatchRef>(q, Q.ocrPoll);
  const stage = new OcrSubmitStage(deps(q, blob), ocr, ds);
  await stage.start();

  await q.send(Q.ocrSubmit, docReady("mistral", [1, 2]));
  await q.idle();

  assert.equal(ocr.submitted.length, 0, "never submitted");
  assert.equal(emitted.length, 0);
  const row = await ds.get(DOC_JOB_ID);
  assert.equal(row?.status, "failed");
  assert.equal(row?.error, "ocr_submit_no_images");
});

// ── ocr-poll (Q.ocrPoll → Q.embed) ────────────────────────────────────────────

function ocrRef(folios: number[]): OcrBatchRef {
  return {
    projectId: PROJECT_ID,
    docJobId: DOC_JOB_ID,
    ark: ARK,
    lane: "mistral",
    meta: META,
    batchId: `batch-${ARK}`,
    folios,
    pollAttempt: 0,
  };
}

/** The poll stage re-enqueues onto its own input queue (Q.ocrPoll). To drain the
 *  pending path we must run the real stage on that queue AND collect from Q.embed.
 *  The stage's own `work` subscription drives the re-enqueue loop. */
test("ocr-poll: done on first poll → emits PreparedDoc, persisted at keys.pages", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const ocr = new FakeOcrEngine(); // default: done on first poll
  await readyRow(ds, "mistral", 3);
  // Prime the batch folios so pollBatch's done state returns pages for them.
  await ocr.submitBatch({ ark: ARK, folios: [1, 2, 3].map((ordre) => ({ ordre, image: Buffer.from("x") })) });

  const emitted = await collect<PreparedDoc>(q, Q.embed);
  const stage = new OcrPollStage(deps(q, blob), ocr, ds);
  await stage.start();

  await q.send(Q.ocrPoll, ocrRef([1, 2, 3]));
  await q.idle();

  assert.equal(emitted.length, 1);
  const doc = emitted[0];
  assert.ok(doc);
  assert.equal(doc.lane, "mistral");
  assert.deepEqual(doc.pages.map((p) => p.ordre), [1, 2, 3]);

  const persisted = await blob.getJson<PreparedPage[]>(keys.pages(ARK));
  assert.ok(persisted);
  assert.equal(persisted.length, 3);
});

test("ocr-poll: pending then done re-enqueues and eventually emits", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const ocr = new FakeOcrEngine({ pendingPolls: 3 }); // pending on polls 1,2; done on 3
  await readyRow(ds, "mistral", 2);
  await ocr.submitBatch({ ark: ARK, folios: [1, 2].map((ordre) => ({ ordre, image: Buffer.from("x") })) });

  const emitted = await collect<PreparedDoc>(q, Q.embed);
  const stage = new OcrPollStage(deps(q, blob), ocr, ds);
  await stage.start();

  await q.send(Q.ocrPoll, ocrRef([1, 2]));
  await q.idle(); // drains the self-re-enqueue loop until done

  assert.equal(emitted.length, 1, "eventually emits one PreparedDoc after draining pending polls");
  assert.deepEqual(emitted[0]?.pages.map((p) => p.ordre), [1, 2]);
});

test("ocr-poll: batch failure → terminal fail + doc-state failed", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const ocr = new FakeOcrEngine({ fail: true });
  await readyRow(ds, "mistral", 2);

  const emitted = await collect<PreparedDoc>(q, Q.embed);
  const stage = new OcrPollStage(deps(q, blob), ocr, ds);
  await stage.start();

  await q.send(Q.ocrPoll, ocrRef([1, 2]));
  await q.idle();

  assert.equal(emitted.length, 0);
  const row = await ds.get(DOC_JOB_ID);
  assert.equal(row?.status, "failed");
  assert.match(row?.error ?? "", /ocr_batch_failed/);
});

test("ocr-poll: maxPolls exceeded on a never-completing batch → terminal ocr_timeout", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const ocr = new FakeOcrEngine({ pendingPolls: 9999 }); // never completes
  await readyRow(ds, "mistral", 2);

  const emitted = await collect<PreparedDoc>(q, Q.embed);
  const stage = new OcrPollStage(deps(q, blob), ocr, ds, { maxPolls: 1 });
  await stage.start();

  await q.send(Q.ocrPoll, ocrRef([1, 2]));
  await q.idle();

  assert.equal(emitted.length, 0);
  const row = await ds.get(DOC_JOB_ID);
  assert.equal(row?.status, "failed");
  assert.equal(row?.error, "ocr_timeout");
});

// ── embed (Q.embed → Q.register) ──────────────────────────────────────────────

function preparedDoc(lane: Lane, pages: PreparedPage[]): PreparedDoc {
  return { projectId: PROJECT_ID, docJobId: DOC_JOB_ID, ark: ARK, lane, meta: META, pages };
}

test("embed: persists embeddings (dim 4), emits EmbeddedDoc", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  await readyRow(ds, "text", 2);

  const pages: PreparedPage[] = [
    { ordre: 1, text: "page one" },
    { ordre: 2, text: "page two text" },
  ];

  const emitted = await collect<EmbeddedDoc>(q, Q.register);
  const stage = new EmbedStage(deps(q, blob), new FakeEmbedder(), ds, undefined);
  await stage.start();

  await q.send(Q.embed, preparedDoc("text", pages));
  await q.idle();

  assert.equal(emitted.length, 1);
  const out = emitted[0];
  assert.ok(out);
  assert.equal(out.embeddingsKey, keys.embeddings(ARK));
  assert.equal(out.pageCount, 2);

  const blobJson = await blob.getJson<{ dim: number; vectors: number[][] }>(keys.embeddings(ARK));
  assert.ok(blobJson);
  assert.equal(blobJson.dim, 4);
  assert.equal(blobJson.vectors.length, 2);
  assert.equal(blobJson.vectors[0]?.length, 4, "each vector has dim 4");
});

test("embed: vector/page count mismatch → terminal fail + doc-state failed", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  await readyRow(ds, "text", 3);

  const shortEmbedder: Embedder = {
    dim: 4,
    async embed(texts) {
      // Return fewer vectors than pages → misalignment.
      return texts.slice(1).map(() => [0, 1, 2, 3]);
    },
  };

  const pages: PreparedPage[] = [
    { ordre: 1, text: "a" },
    { ordre: 2, text: "b" },
    { ordre: 3, text: "c" },
  ];

  const emitted = await collect<EmbeddedDoc>(q, Q.register);
  const stage = new EmbedStage(deps(q, blob), shortEmbedder, ds, undefined);
  await stage.start();

  await q.send(Q.embed, preparedDoc("text", pages));
  await q.idle();

  assert.equal(emitted.length, 0);
  const row = await ds.get(DOC_JOB_ID);
  assert.equal(row?.status, "failed");
  assert.match(row?.error ?? "", /embed_count_mismatch 2\/3/);
});

// ── register (Q.register, terminal) ───────────────────────────────────────────

function embeddedDoc(): EmbeddedDoc {
  return {
    projectId: PROJECT_ID,
    docJobId: DOC_JOB_ID,
    ark: ARK,
    meta: META,
    embeddingsKey: keys.embeddings(ARK),
    pageCount: 2,
  };
}

/** Pre-populate the pages + embeddings artifacts register reads back. */
async function primeRegisterArtifacts(blob: MemoryBlobStore): Promise<void> {
  const pages: PreparedPage[] = [
    { ordre: 1, text: "page one" },
    { ordre: 2, text: "page two" },
  ];
  await blob.putJson(keys.pages(ARK), pages);
  await blob.putJson(keys.embeddings(ARK), {
    dim: 4,
    vectors: [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ],
  });
}

test("register: upserts, writes receipt, sets doc-state done", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const cluster = new FakeClusterSink();
  await readyRow(ds, "text", 2);
  await primeRegisterArtifacts(blob);

  const stage = new RegisterStage(deps(q, blob), cluster, ds);
  await stage.start();

  await q.send(Q.register, embeddedDoc());
  await q.idle();

  assert.equal(cluster.upserts.length, 1, "one upsert into the cluster");
  assert.equal(cluster.upserts[0]?.ark, ARK);
  assert.equal(cluster.upserts[0]?.pages, 2);

  const receipt = await blob.getJson<{ datasetId: number; entryId: number }>(keys.registered(ARK));
  assert.ok(receipt, "registration receipt written");

  const row = await ds.get(DOC_JOB_ID);
  assert.equal(row?.status, "done");
});

test("register: re-delivery with receipt present → no second upsert, still done", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const cluster = new FakeClusterSink();
  await readyRow(ds, "text", 2);
  await primeRegisterArtifacts(blob);

  const stage = new RegisterStage(deps(q, blob), cluster, ds);
  await stage.start();

  await q.send(Q.register, embeddedDoc());
  await q.idle();
  // Second delivery — receipt now exists.
  await q.send(Q.register, embeddedDoc());
  await q.idle();

  assert.equal(cluster.upserts.length, 1, "dedup via receipt — no second upsert");
  const row = await ds.get(DOC_JOB_ID);
  assert.equal(row?.status, "done");
});

test("register: missing artifacts → terminal fail (no upsert)", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const cluster = new FakeClusterSink();
  await readyRow(ds, "text", 2);
  // No pages / embeddings primed.

  const stage = new RegisterStage(deps(q, blob), cluster, ds);
  await stage.start();

  await q.send(Q.register, embeddedDoc());
  await q.idle();

  assert.equal(cluster.upserts.length, 0, "never upserts without artifacts");
  // register's missing-artifacts fail is a raw terminal fail (it does not flip
  // doc-state itself), so the doc-state row stays where the Monitor left it.
  const row = await ds.get(DOC_JOB_ID);
  assert.notEqual(row?.status, "done");

  const counts = await q.counts(Q.register);
  assert.equal(counts.completed, 1, "terminal fail completes the message (no retry storm)");
  assert.equal(counts.failed, 0);
});
