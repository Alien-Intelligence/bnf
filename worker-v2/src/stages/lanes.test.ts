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

test("ocr-submit: after F15 un-poisons a dead handle, a re-ingest submits a FRESH batch", async () => {
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
  assert.equal(ocr.submitted.length, 1);

  // ocr-poll's un-poison path (F15): the batch turned out to be dead — delete
  // the handle, exactly as OcrPollStage does on a terminal failure/zero-survivor
  // outcome (see lanes.test.ts's ocr-poll tests above).
  await blob.delete(keys.ocrBatch(ARK));

  // A re-ingest of the same ARK (a fresh doc-ready delivery) must NOT dedupe
  // onto the now-deleted handle — it submits a brand-new paid batch.
  await q.send(Q.ocrSubmit, docReady("mistral", [1, 2]));
  await q.idle();

  assert.equal(ocr.submitted.length, 2, "the dead handle is gone — dedupe no longer masks a fresh submit");
  assert.equal(emitted.length, 2);
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

test("ocr-poll: batch failure → terminal fail + doc-state failed + batch handle deleted (F15)", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const ocr = new FakeOcrEngine({ fail: true });
  await readyRow(ds, "mistral", 2);
  // Simulate ocr-submit having already persisted the (now-dead) batch handle.
  await blob.putJson(keys.ocrBatch(ARK), { batchId: `batch-${ARK}`, folios: [1, 2] });

  const emitted = await collect<PreparedDoc>(q, Q.embed);
  const stage = new OcrPollStage(deps(q, blob), ocr, ds);
  await stage.start();

  await q.send(Q.ocrPoll, ocrRef([1, 2]));
  await q.idle();

  assert.equal(emitted.length, 0);
  const row = await ds.get(DOC_JOB_ID);
  assert.equal(row?.status, "failed");
  assert.match(row?.error ?? "", /ocr_batch_failed/);
  assert.equal(
    await blob.getJson(keys.ocrBatch(ARK)),
    null,
    "the dead batch handle is deleted so a re-ingest resubmits fresh",
  );
});

test("ocr-poll: zero surviving pages (all hallucinated) → failDoc with the honest reason + handle deleted (F13/F15)", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const ocr = new FakeOcrEngine({ hallucinatedOrdres: [1, 2] });
  await readyRow(ds, "mistral", 2);
  await ocr.submitBatch({ ark: ARK, folios: [1, 2].map((ordre) => ({ ordre, image: Buffer.from("x") })) });
  await blob.putJson(keys.ocrBatch(ARK), { batchId: `batch-${ARK}`, folios: [1, 2] });

  const emitted = await collect<PreparedDoc>(q, Q.embed);
  const stage = new OcrPollStage(deps(q, blob), ocr, ds);
  await stage.start();

  await q.send(Q.ocrPoll, ocrRef([1, 2]));
  await q.idle();

  assert.equal(emitted.length, 0);
  const row = await ds.get(DOC_JOB_ID);
  assert.equal(row?.status, "failed");
  assert.equal(row?.error, "ocr_pages_dropped: 0/2 usable (hallucination détectée)");
  assert.notEqual(row?.error, "ocr_no_text", "must never regress to the old lying reason");
  assert.equal(
    await blob.getJson(keys.ocrBatch(ARK)),
    null,
    "zero-survivor batches are also un-poisoned",
  );
});

test("ocr-poll: partial survivors → doc proceeds AND the drop is recorded (F13)", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const ocr = new FakeOcrEngine({ hallucinatedOrdres: [2], emptyOrdres: [3] });
  await readyRow(ds, "mistral", 3);
  await ocr.submitBatch({
    ark: ARK,
    folios: [1, 2, 3].map((ordre) => ({ ordre, image: Buffer.from("x") })),
  });
  await blob.putJson(keys.ocrBatch(ARK), { batchId: `batch-${ARK}`, folios: [1, 2, 3] });

  const emitted = await collect<PreparedDoc>(q, Q.embed);
  const stage = new OcrPollStage(deps(q, blob), ocr, ds);
  await stage.start();

  await q.send(Q.ocrPoll, ocrRef([1, 2, 3]));
  await q.idle();

  assert.equal(emitted.length, 1, "the doc still proceeds — partial by design");
  assert.deepEqual(emitted[0]?.pages.map((p) => p.ordre), [1]);

  const row = await ds.get(DOC_JOB_ID);
  assert.notEqual(row?.status, "failed");
  assert.equal(row?.pagesDropped, 2);
  assert.equal(row?.dropReason, "hallucination détectée, pages vides");

  // The batch produced a usable result — the handle survives (paid-dedupe
  // invariant: only a dead batch gets its handle deleted).
  assert.ok(await blob.getJson(keys.ocrBatch(ARK)), "handle NOT deleted on a partial success");
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

test("embed: unchanged pages → cache hit, embedder never called", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  await readyRow(ds, "text", 2);

  const pages: PreparedPage[] = [
    { ordre: 1, text: "page one" },
    { ordre: 2, text: "page two text" },
  ];

  let embedCalls = 0;
  const countingEmbedder: Embedder = {
    dim: 4,
    async embed(texts) {
      embedCalls++;
      return texts.map(() => [0, 1, 2, 3]);
    },
  };

  const emitted = await collect<EmbeddedDoc>(q, Q.register);
  const stage = new EmbedStage(deps(q, blob), countingEmbedder, ds, undefined);
  await stage.start();

  // First delivery populates the cache (with its pagesHash).
  await q.send(Q.embed, preparedDoc("text", pages));
  await q.idle();
  assert.equal(embedCalls, 1, "first delivery embeds");

  // Second, independent delivery with the SAME pages content.
  await q.send(Q.embed, preparedDoc("text", pages));
  await q.idle();

  assert.equal(embedCalls, 1, "second delivery hits the content-aware cache — no re-embed");
  assert.equal(emitted.length, 2, "both deliveries still emit");
});

test("embed: same page count but changed text → cache rejected, re-embeds", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  await readyRow(ds, "text", 2);

  let embedCalls = 0;
  const countingEmbedder: Embedder = {
    dim: 4,
    async embed(texts) {
      embedCalls++;
      return texts.map(() => [0, 1, 2, 3]);
    },
  };

  const emitted = await collect<EmbeddedDoc>(q, Q.register);
  const stage = new EmbedStage(deps(q, blob), countingEmbedder, ds, undefined);
  await stage.start();

  await q.send(
    Q.embed,
    preparedDoc("text", [
      { ordre: 1, text: "page one, first OCR pass" },
      { ordre: 2, text: "page two, first OCR pass" },
    ]),
  );
  await q.idle();
  assert.equal(embedCalls, 1);

  // Re-ingest after an OCR quality fix: SAME page count, DIFFERENT content.
  await q.send(
    Q.embed,
    preparedDoc("text", [
      { ordre: 1, text: "page one, corrected OCR pass" },
      { ordre: 2, text: "page two, corrected OCR pass" },
    ]),
  );
  await q.idle();

  assert.equal(embedCalls, 2, "count-only match must NOT be trusted — content changed, must re-embed");
  assert.equal(emitted.length, 2);

  const stored = await blob.getJson<{ vectors: number[][]; pagesHash?: string }>(
    keys.embeddings(ARK),
  );
  assert.ok(stored?.pagesHash, "blob is rewritten with the new content's hash");
});

test("embed: legacy blob without pagesHash → treated as miss, re-embedded and rewritten with a hash", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  await readyRow(ds, "text", 2);

  const pages: PreparedPage[] = [
    { ordre: 1, text: "page one" },
    { ordre: 2, text: "page two text" },
  ];
  // Simulate a blob written before F17: count matches, but no pagesHash field.
  await blob.putJson(keys.embeddings(ARK), {
    dim: 4,
    vectors: [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ],
  });

  let embedCalls = 0;
  const countingEmbedder: Embedder = {
    dim: 4,
    async embed(texts) {
      embedCalls++;
      return texts.map(() => [9, 9, 9, 9]);
    },
  };

  const emitted = await collect<EmbeddedDoc>(q, Q.register);
  const stage = new EmbedStage(deps(q, blob), countingEmbedder, ds, undefined);
  await stage.start();

  await q.send(Q.embed, preparedDoc("text", pages));
  await q.idle();

  assert.equal(embedCalls, 1, "legacy blob (no hash) is never trusted — re-embeds once");
  assert.equal(emitted.length, 1);

  const stored = await blob.getJson<{ vectors: number[][]; pagesHash?: string }>(
    keys.embeddings(ARK),
  );
  assert.ok(stored?.pagesHash, "the rewritten blob now carries a pagesHash");
  assert.deepEqual(stored?.vectors[0], [9, 9, 9, 9], "rewritten with the freshly embedded vectors");
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

  const receipt = await blob.getJson<{ datasetId: number; entryId: number }>(
    keys.registered(PROJECT_ID, ARK),
  );
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

// ── register: per-project receipt identity (F16) ──────────────────────────────

test("register: two projects ingesting the SAME ark → both upsert, receipts stored under distinct keys", async () => {
  // One stage instance (as in the real worker: one RegisterStage serves every
  // project) fed with two EmbeddedDoc messages for the SAME ark but different
  // projects/docJobIds. Proves the per-project receipt key (F16) — not a
  // cross-project dedup — governs whether an upsert happens.
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const cluster = new FakeClusterSink();

  const PROJECT_A = "proj-a";
  const PROJECT_B = "proj-b";
  const JOB_A = "doc-a";
  const JOB_B = "doc-b";

  for (const [docJobId, projectId] of [
    [JOB_A, PROJECT_A],
    [JOB_B, PROJECT_B],
  ] as const) {
    await ds.upsertDoc({ docJobId, projectId, ark: ARK });
    await ds.recordPlan(docJobId, { lane: "text", pagesExpected: 2, meta: META });
    await ds.claimRoute(docJobId, "ready");
  }
  await primeRegisterArtifacts(blob);

  const stage = new RegisterStage(deps(q, blob), cluster, ds);
  await stage.start();

  await q.send(Q.register, {
    projectId: PROJECT_A,
    docJobId: JOB_A,
    ark: ARK,
    meta: META,
    embeddingsKey: keys.embeddings(ARK),
    pageCount: 2,
  } satisfies EmbeddedDoc);
  await q.idle();

  await q.send(Q.register, {
    projectId: PROJECT_B,
    docJobId: JOB_B,
    ark: ARK,
    meta: META,
    embeddingsKey: keys.embeddings(ARK),
    pageCount: 2,
  } satisfies EmbeddedDoc);
  await q.idle();

  assert.equal(cluster.upserts.length, 2, "each project upserts into ITS OWN dataset — no cross-project dedup");
  assert.notEqual(
    cluster.upserts[0]?.datasetId,
    cluster.upserts[1]?.datasetId,
    "the two projects landed in two distinct datasets",
  );

  const receiptA = await blob.getJson<{ datasetId: number; entryId: number }>(
    keys.registered(PROJECT_A, ARK),
  );
  const receiptB = await blob.getJson<{ datasetId: number; entryId: number }>(
    keys.registered(PROJECT_B, ARK),
  );
  assert.ok(receiptA);
  assert.ok(receiptB);
  assert.notEqual(keys.registered(PROJECT_A, ARK), keys.registered(PROJECT_B, ARK));

  assert.equal((await ds.get(JOB_A))?.status, "done");
  assert.equal((await ds.get(JOB_B))?.status, "done");
});

test("register: receipt datasetId mismatch (dataset recreated) → re-upsert + receipt overwritten", async () => {
  // ensureDataset() is memoized PER STAGE INSTANCE (process-lifetime cache, see
  // register.ts's doc comment) — so this test models the realistic trigger for
  // observing a recreation: a fresh RegisterStage per delivery, exactly like a
  // fresh worker process picking up the redelivered doc after a restart. A
  // single long-lived stage instance would keep trusting its own memo across a
  // recreation that happened entirely out-of-band — the documented, accepted
  // narrow race — so that is deliberately NOT what this test exercises.
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const cluster = new FakeClusterSink();
  await readyRow(ds, "text", 2);
  await primeRegisterArtifacts(blob);

  // First delivery: registers normally against the project's original dataset.
  const stage1 = new RegisterStage(deps(q, blob), cluster, ds);
  await stage1.start();
  await q.send(Q.register, embeddedDoc());
  await q.idle();
  assert.equal(cluster.upserts.length, 1);
  const firstReceipt = await blob.getJson<{ datasetId: number; entryId: number }>(
    keys.registered(PROJECT_ID, ARK),
  );
  assert.ok(firstReceipt);

  // The project's dataset is deleted and recreated — a NEW id for the same project.
  const newDatasetId = cluster.recreateDataset(PROJECT_ID);
  assert.notEqual(newDatasetId, firstReceipt.datasetId);

  // Re-delivery on a fresh stage instance (cold memo): the stale receipt must
  // NOT dedup silently.
  const stage2 = new RegisterStage(deps(q, blob), cluster, ds);
  await stage2.start();
  await q.send(Q.register, embeddedDoc());
  await q.idle();

  assert.equal(cluster.upserts.length, 2, "stale receipt must trigger a re-upsert, not a silent dedup");
  assert.equal(cluster.upserts[1]?.datasetId, newDatasetId);

  const secondReceipt = await blob.getJson<{ datasetId: number; entryId: number }>(
    keys.registered(PROJECT_ID, ARK),
  );
  assert.equal(secondReceipt?.datasetId, newDatasetId, "receipt overwritten with the current dataset");

  // A THIRD delivery, still on stage2 (now correctly memoized to newDatasetId),
  // must dedup against the now-current receipt.
  await q.send(Q.register, embeddedDoc());
  await q.idle();
  assert.equal(cluster.upserts.length, 2, "matching receipt dedups again once it is current");
});

test("register: old GLOBAL-key receipt (pre-F16 shape) is ignored — fresh per-project upsert happens", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const ds = new MemoryDocState();
  const cluster = new FakeClusterSink();
  await readyRow(ds, "text", 2);
  await primeRegisterArtifacts(blob);

  // Write a receipt at the OLD, ARK-only global key shape (registered/<slug>.json)
  // to prove the stage never reads it.
  const oldGlobalKey = `registered/${ARK.replace(/^ark:\/12148\//, "")}.json`;
  await blob.putJson(oldGlobalKey, { datasetId: 999, entryId: 999 });

  const stage = new RegisterStage(deps(q, blob), cluster, ds);
  await stage.start();

  await q.send(Q.register, embeddedDoc());
  await q.idle();

  assert.equal(cluster.upserts.length, 1, "the global-key receipt is ignored — a real upsert happens");
  // The per-project receipt is written at the NEW key shape, independent of the
  // untouched old one.
  const perProjectReceipt = await blob.getJson<{ datasetId: number; entryId: number }>(
    keys.registered(PROJECT_ID, ARK),
  );
  assert.ok(perProjectReceipt);
  assert.notEqual(perProjectReceipt.entryId, 999, "not the stale global receipt's entryId");

  const untouchedOld = await blob.getJson<{ datasetId: number; entryId: number }>(oldGlobalKey);
  assert.equal(untouchedOld?.entryId, 999, "the old global key is left untouched (no migration)");
});
