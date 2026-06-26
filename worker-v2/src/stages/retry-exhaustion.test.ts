/**
 * Regression test for the orphaned-doc bug the live 1-doc gate surfaced
 * (2026-06-26): when a *transient* error exhausts the queue's retries (e.g. the
 * persistent manifest-500 ARKs, or a flaky cluster), the stage throws and pg-boss
 * fails the job — but the DOC ROW must still reach a terminal `failed` state, or
 * it orphans in a non-terminal status and never reconciles in the progress model.
 * metadata / manifest / register now convert the LAST attempt into a terminal
 * doc-fail (the idiom fetch already used). These tests drive a real MemoryQueue so
 * the retries actually happen, then assert the doc is `failed`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryQueue } from "../core/queue-memory.js";
import { MemoryBlobStore } from "../core/blob.js";
import { createMemoryLogger } from "../core/logger.js";
import { MemoryDocState } from "../domain/doc-state-memory.js";
import { Q } from "../domain/queues.js";
import type { DocMeta, DocRef, EmbeddedDoc, ManifestReq } from "../domain/types.js";
import { MetadataStage } from "./metadata.js";
import { ManifestStage } from "./manifest.js";
import { RegisterStage } from "./register.js";
import { keys } from "../domain/keys.js";
import { FakeBnfClient, FakeClusterSink } from "../testing/fakes.js";
import type { ClusterSink } from "../ports.js";

const META: DocMeta = {
  title: null,
  creator: null,
  date: null,
  docType: "estampe",
  subtype: null,
  lang: null,
  pageCount: 3,
  ocrAvailable: false,
};

test("metadata: transient OAI exhaustion → doc failed (not orphaned)", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const { logger } = createMemoryLogger();
  const ds = new MemoryDocState();
  const bnf = new FakeBnfClient().add({
    ark: "ark:/12148/flaky",
    ocrAvailable: true,
    docType: "texte",
    pageCount: 3,
    metadataFault: { alwaysTransient: true, status: 500 },
  });
  const stage = new MetadataStage({ queue: q, blob, log: logger }, bnf, ds, { mistralEnabled: false });
  await stage.start();
  const ref: DocRef = { projectId: "p", docJobId: "d1", ark: "ark:/12148/flaky" };
  await ds.upsertDoc(ref);
  await q.send(Q.metadata, ref);
  await q.idle();

  const row = await ds.get("d1");
  assert.equal(row?.status, "failed", "doc must be terminally failed, not orphaned");
  assert.ok(bnf.calls.metadata >= 2, "should have retried before giving up");
});

test("manifest: persistent 500 exhaustion → doc failed (not orphaned)", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const { logger } = createMemoryLogger();
  const ds = new MemoryDocState();
  const bnf = new FakeBnfClient().add({
    ark: "ark:/12148/m500",
    ocrAvailable: false,
    docType: "estampe",
    pageCount: 3,
    manifestFault: { alwaysTransient: true, status: 500 },
  });
  const stage = new ManifestStage({ queue: q, blob, log: logger }, bnf, ds, undefined);
  await stage.start();
  const req: ManifestReq = { projectId: "p", docJobId: "d2", ark: "ark:/12148/m500", lane: "vision", meta: META };
  await ds.upsertDoc(req);
  await q.send(Q.manifest, req);
  await q.idle();

  const row = await ds.get("d2");
  assert.equal(row?.status, "failed");
  assert.ok(bnf.calls.manifest >= 2, "should have retried the manifest before failing");
});

class AlwaysFailingCluster implements ClusterSink {
  calls = 0;
  async ensureDataset(): Promise<{ datasetId: number }> {
    return { datasetId: 1 };
  }
  async upsert(): Promise<{ entryId: number }> {
    this.calls++;
    throw new Error("cluster timeout");
  }
}

test("register: cluster failure exhaustion → doc failed (not orphaned in 'ready')", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const { logger } = createMemoryLogger();
  const ds = new MemoryDocState();
  await ds.upsertDoc({ projectId: "p", docJobId: "d3", ark: "ark:/12148/reg" });
  await ds.recordPlan("d3", { lane: "text", pagesExpected: 1, meta: { ...META, ocrAvailable: true } });
  await ds.claimRoute("d3", "ready");
  await blob.putJson(keys.pages("ark:/12148/reg"), [{ ordre: 1, text: "hi" }]);
  await blob.putJson("embkey", { dim: 4, vectors: [[1, 2, 3, 4]] });

  const cluster = new AlwaysFailingCluster();
  const stage = new RegisterStage({ queue: q, blob, log: logger }, cluster, ds);
  await stage.start();
  const doc: EmbeddedDoc = {
    projectId: "p",
    docJobId: "d3",
    ark: "ark:/12148/reg",
    meta: { ...META, ocrAvailable: true },
    embeddingsKey: "embkey",
    pageCount: 1,
  };
  await q.send(Q.register, doc);
  await q.idle();

  const row = await ds.get("d3");
  assert.equal(row?.status, "failed");
  assert.ok(cluster.calls >= 2, "should have retried the cluster before failing");
});

// Sanity: the happy cluster still registers (no false positives from the new guard).
test("register: happy path still marks done", async () => {
  const q = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const { logger } = createMemoryLogger();
  const ds = new MemoryDocState();
  await ds.upsertDoc({ projectId: "p", docJobId: "d4", ark: "ark:/12148/ok" });
  await ds.recordPlan("d4", { lane: "text", pagesExpected: 1, meta: { ...META, ocrAvailable: true } });
  await ds.claimRoute("d4", "ready");
  await blob.putJson(keys.pages("ark:/12148/ok"), [{ ordre: 1, text: "hi" }]);
  await blob.putJson("embkey2", { dim: 4, vectors: [[1, 2, 3, 4]] });

  const stage = new RegisterStage({ queue: q, blob, log: logger }, new FakeClusterSink(), ds);
  await stage.start();
  await q.send(Q.register, {
    projectId: "p",
    docJobId: "d4",
    ark: "ark:/12148/ok",
    meta: { ...META, ocrAvailable: true },
    embeddingsKey: "embkey2",
    pageCount: 1,
  } satisfies EmbeddedDoc);
  await q.idle();

  assert.equal((await ds.get("d4"))?.status, "done");
});
