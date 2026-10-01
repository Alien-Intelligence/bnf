/**
 * HTTP ingress tests — drive the real Node server over a loopback socket with the
 * memory stores/queue. Covers the app contract: POST /ingest → { clusterJobId } +
 * a seeded run; GET /progress/:runId read-model + 404; /health; cancel; bad body.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { MemoryQueue } from "./core/queue-memory.js";
import { MemoryBlobStore } from "./core/blob.js";
import { MemoryDocState } from "./domain/doc-state-memory.js";
import { MemoryRunStore } from "./domain/run-store-memory.js";
import { MemoryOcrBackfillStore } from "./domain/ocr-backfill-memory.js";
import { createMemoryLogger } from "./core/logger.js";
import { keys } from "./domain/keys.js";
import { Q } from "./domain/queues.js";
import type { DocOcrQuality } from "./domain/types.js";
import { TerminalEmitter } from "./live/progress-callback.js";
import { CompletionMonitor } from "./live/completion-monitor.js";
import { startServer, type ServerDeps } from "./server.js";

const RETRY_FAILED_AFTER_MS = 60_000;

async function bootServer(opts: { ocrBackfillEnabled?: boolean; now?: () => number } = {}): Promise<{
  base: string;
  deps: ServerDeps;
  blob: MemoryBlobStore;
  ocrBackfill: MemoryOcrBackfillStore;
  close: () => Promise<void>;
}> {
  const queue = new MemoryQueue();
  const docState = new MemoryDocState();
  const runStore = new MemoryRunStore();
  const blob = new MemoryBlobStore();
  const ocrBackfill = new MemoryOcrBackfillStore(opts.now ? { now: opts.now } : {});
  const { logger } = createMemoryLogger();
  const emitter = new TerminalEmitter(docState, runStore, logger, {
    // Terminal POSTs in these tests just succeed; the callback path itself is
    // covered in progress-callback.test.ts.
    fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
  });
  const completion = new CompletionMonitor(docState, runStore, emitter, logger);
  const deps: ServerDeps = {
    runStore, docState, queue, completion, log: logger,
    fetchRatePerMin: 300, manifestRatePerMin: 42,
    blob,
    ocrBackfill,
    ocrBackfillEnabled: opts.ocrBackfillEnabled ?? true,
    ocrBackfillRetryFailedAfterMs: RETRY_FAILED_AFTER_MS,
  };
  const server = await startServer(deps, 0);
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    deps,
    blob,
    ocrBackfill,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const ingestBody = (arks: string[]) => ({
  projectId: "p1",
  targetVersionId: "v2",
  appJobId: "job-1",
  added: arks.map((ark) => ({ ark, title: ark, year: null, docType: "texte", subtype: null, lang: "fre", source: "Gallica", iiifManifestUrl: null })),
  removed: [],
  callbackUrl: "http://127.0.0.1:1/api/internal/ingest/job-1/progress",
  callbackSecret: "s3cr3t",
});

test("GET /health → 200 ok", async () => {
  const { base, close } = await bootServer();
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await close();
  }
});

test("POST /ingest → { clusterJobId } and a seeded run", async () => {
  const { base, deps, close } = await bootServer();
  try {
    const res = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ingestBody(["ark:/12148/a", "ark:/12148/b"])),
    });
    assert.equal(res.status, 200);
    const { clusterJobId } = (await res.json()) as { clusterJobId: string };
    assert.equal(typeof clusterJobId, "string");

    const run = await deps.runStore.get(clusterJobId);
    assert.equal(run?.totalDocs, 2);
    assert.equal((await deps.queue.counts(Q.metadata)).queued, 2);
  } finally {
    await close();
  }
});

test("POST /ingest with a malformed body → 400", async () => {
  const { base, close } = await bootServer();
  try {
    const bad = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    assert.equal(bad.status, 400);

    const missing = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "p1" }),
    });
    assert.equal(missing.status, 400);
  } finally {
    await close();
  }
});

test("GET /progress/:runId returns the read-model; unknown run → 404", async () => {
  const { base, close } = await bootServer();
  try {
    const submit = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ingestBody(["ark:/12148/a"])),
    });
    const { clusterJobId } = (await submit.json()) as { clusterJobId: string };

    const res = await fetch(`${base}/progress/${clusterJobId}`);
    assert.equal(res.status, 200);
    const report = (await res.json()) as { docsTotal: number; reconciles: boolean; stages: Record<string, unknown> };
    assert.equal(report.docsTotal, 1);
    assert.equal(report.reconciles, true);
    assert.ok(report.stages);

    const missing = await fetch(`${base}/progress/does-not-exist`);
    assert.equal(missing.status, 404);
  } finally {
    await close();
  }
});

test("POST /ingest/:runId/cancel marks the run canceled; unknown → 404", async () => {
  const { base, deps, close } = await bootServer();
  try {
    const submit = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ingestBody(["ark:/12148/a"])),
    });
    const { clusterJobId } = (await submit.json()) as { clusterJobId: string };

    const res = await fetch(`${base}/ingest/${clusterJobId}/cancel`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal((await deps.runStore.get(clusterJobId))?.canceled, true);

    const missing = await fetch(`${base}/ingest/nope/cancel`, { method: "POST" });
    assert.equal(missing.status, 404);
  } finally {
    await close();
  }
});

test("unknown route → 404", async () => {
  const { base, close } = await bootServer();
  try {
    const res = await fetch(`${base}/whatever`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

// ── POST /ocr-quality/sync ────────────────────────────────────────────────────

const ARK_A = "ark:/12148/bpt6k4625753w";
const ARK_B = "ark:/12148/bpt6k1234567z";

function artifactFor(ark: string): DocOcrQuality {
  return {
    v: 1,
    ark,
    ocrRate: 0.7821,
    lane: "text",
    folios: [
      { ordre: 1, ocrSource: "alto", ocrQuality: 0.932, wordCount: 5106 },
      { ordre: 2, ocrSource: "alto", ocrQuality: 0.661, wordCount: 4016 },
    ],
    builtAt: "2026-10-01T00:00:00.000Z",
  };
}

interface SyncResponse {
  documents: DocOcrQuality[];
  building: string[];
  unavailable: Array<{ ark: string; reason: string }>;
}

async function sync(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/ocr-quality/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("POST /ocr-quality/sync: an existing artifact is returned in documents; a missing one is queued once", async () => {
  const { base, deps, blob, ocrBackfill, close } = await bootServer();
  try {
    await blob.putJson(keys.ocrQuality(ARK_A), artifactFor(ARK_A));

    const res = await sync(base, { arks: [ARK_A, ARK_B] });
    assert.equal(res.status, 200);
    const body = (await res.json()) as SyncResponse;
    assert.deepEqual(body.documents, [artifactFor(ARK_A)]);
    assert.deepEqual(body.building, [ARK_B]);
    assert.deepEqual(body.unavailable, []);
    assert.equal((await deps.queue.counts(Q.ocrQualityBackfill)).queued, 1, "one build queued");
    assert.equal((await ocrBackfill.get(ARK_B))?.state, "queued");

    // A second call for the same missing ARK: still building, NO second send.
    const again = (await (await sync(base, { arks: [ARK_B] })).json()) as SyncResponse;
    assert.deepEqual(again.building, [ARK_B]);
    assert.equal((await deps.queue.counts(Q.ocrQualityBackfill)).queued, 1, "deduped through the store");
  } finally {
    await close();
  }
});

test("POST /ocr-quality/sync: a recently failed row is unavailable with its reason; one older than the retry age is re-queued", async () => {
  let clock = 1_000_000;
  const { base, deps, ocrBackfill, close } = await bootServer({ now: () => clock });
  try {
    await ocrBackfill.request(ARK_B, RETRY_FAILED_AFTER_MS);
    await ocrBackfill.markFailed(ARK_B, "no_pages_artifact");

    const fresh = (await (await sync(base, { arks: [ARK_B] })).json()) as SyncResponse;
    assert.deepEqual(fresh.unavailable, [{ ark: ARK_B, reason: "no_pages_artifact" }]);
    assert.deepEqual(fresh.building, []);
    assert.equal((await deps.queue.counts(Q.ocrQualityBackfill)).queued, 0, "a fresh failure is not re-driven");

    clock += RETRY_FAILED_AFTER_MS + 1;
    const later = (await (await sync(base, { arks: [ARK_B] })).json()) as SyncResponse;
    assert.deepEqual(later.building, [ARK_B]);
    assert.deepEqual(later.unavailable, []);
    assert.equal((await deps.queue.counts(Q.ocrQualityBackfill)).queued, 1, "re-queued after the retry age");
    assert.equal((await ocrBackfill.get(ARK_B))?.state, "queued");
  } finally {
    await close();
  }
});

test("POST /ocr-quality/sync: bad bodies → 400 (not JSON, no arks, > max, non-canonical ARK)", async () => {
  const { base, deps, close } = await bootServer();
  try {
    assert.equal((await sync(base, "{ not json")).status, 400);
    assert.equal((await sync(base, { arks: [] })).status, 400);
    assert.equal((await sync(base, { nope: true })).status, 400);
    const tooMany = Array.from({ length: 101 }, (_, i) => `ark:/12148/bpt6k${i}`);
    assert.equal((await sync(base, { arks: tooMany })).status, 400);
    assert.equal((await sync(base, { arks: ["https://gallica.bnf.fr/ark:/12148/x"] })).status, 400);
    assert.equal((await sync(base, { arks: [42] })).status, 400);
    assert.equal((await deps.queue.counts(Q.ocrQualityBackfill)).queued, 0, "nothing queued by a rejected request");
  } finally {
    await close();
  }
});

test("POST /ocr-quality/sync with the backfill disabled: a missing ARK is unavailable:backfill_disabled, nothing queued, no row", async () => {
  const { base, deps, blob, ocrBackfill, close } = await bootServer({ ocrBackfillEnabled: false });
  try {
    await blob.putJson(keys.ocrQuality(ARK_A), artifactFor(ARK_A));
    const body = (await (await sync(base, { arks: [ARK_A, ARK_B] })).json()) as SyncResponse;
    assert.deepEqual(body.documents, [artifactFor(ARK_A)], "existing artifacts are still served");
    assert.deepEqual(body.unavailable, [{ ark: ARK_B, reason: "backfill_disabled" }]);
    assert.deepEqual(body.building, []);
    assert.equal((await deps.queue.counts(Q.ocrQualityBackfill)).queued, 0);
    assert.equal(await ocrBackfill.get(ARK_B), null, "no backfill row is opened");
  } finally {
    await close();
  }
});
