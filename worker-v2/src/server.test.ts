/**
 * HTTP ingress tests — drive the real Node server over a loopback socket with the
 * memory stores/queue. Covers the app contract: POST /ingest → { clusterJobId } +
 * a seeded run; GET /progress/:runId read-model + 404; /health; cancel; bad body.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";

import { MemoryQueue } from "./core/queue-memory.js";
import { MemoryBlobStore } from "./core/blob.js";
import { MemoryDocState } from "./domain/doc-state-memory.js";
import { MemoryRunStore } from "./domain/run-store-memory.js";
import { MemoryOcrBackfillStore } from "./domain/ocr-backfill-memory.js";
import type { OcrBackfillPolicy, OcrBackfillStore } from "./domain/ocr-backfill.js";
import { createMemoryLogger } from "./core/logger.js";
import { keys } from "./domain/keys.js";
import { Q } from "./domain/queues.js";
import type { DocOcrQuality } from "./domain/types.js";
import { TerminalEmitter } from "./live/progress-callback.js";
import { CompletionMonitor } from "./live/completion-monitor.js";
import { startServer, type ServerDeps } from "./server.js";

const POLICY: OcrBackfillPolicy = {
  retryFailedAfterMs: 60_000,
  maxAttempts: 5,
  startedStaleAfterMs: 90 * 60 * 1_000, unstartedStaleAfterMs: 14 * 24 * 60 * 60 * 1_000,
};

async function bootServer(
  opts: {
    ocrBackfillEnabled?: boolean;
    now?: () => number;
    queue?: MemoryQueue;
    store?: OcrBackfillStore;
    syncDeadlineMs?: number;
    bodyReadMs?: number;
  } = {},
): Promise<{
  base: string;
  deps: ServerDeps;
  blob: MemoryBlobStore;
  ocrBackfill: OcrBackfillStore;
  lines: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const queue = opts.queue ?? new MemoryQueue();
  const docState = new MemoryDocState();
  const runStore = new MemoryRunStore();
  const blob = new MemoryBlobStore();
  const ocrBackfill = opts.store ?? new MemoryOcrBackfillStore(opts.now ? { now: opts.now } : {});
  const { logger, lines } = createMemoryLogger();
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
    ocrBackfill: {
      store: ocrBackfill,
      enabled: opts.ocrBackfillEnabled ?? true,
      policy: POLICY,
      concurrency: 1,
    },
    ocrSyncDeadlineMs: opts.syncDeadlineMs ?? 10_000,
    ocrSyncBodyReadMs: opts.bodyReadMs ?? 10_000,
  };
  const server = await startServer(deps, 0);
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    deps,
    blob,
    ocrBackfill,
    lines,
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
const ARK_C = "ark:/12148/btv1b100524476";
const ARK_D = "ark:/12148/btv1b10052448n";

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
    await ocrBackfill.request(ARK_B, POLICY, new AbortController().signal);
    await ocrBackfill.markFailed(ARK_B, "build_failed: 503", { permanent: false });

    const fresh = (await (await sync(base, { arks: [ARK_B] })).json()) as SyncResponse;
    assert.deepEqual(fresh.unavailable, [{ ark: ARK_B, reason: "build_failed: 503" }]);
    assert.deepEqual(fresh.building, []);
    assert.equal((await deps.queue.counts(Q.ocrQualityBackfill)).queued, 0, "a fresh failure is not re-driven");

    clock += POLICY.retryFailedAfterMs + 1;
    const later = (await (await sync(base, { arks: [ARK_B] })).json()) as SyncResponse;
    assert.deepEqual(later.building, [ARK_B]);
    assert.deepEqual(later.unavailable, []);
    assert.equal((await deps.queue.counts(Q.ocrQualityBackfill)).queued, 1, "re-queued after the retry age");
    assert.equal((await ocrBackfill.get(ARK_B))?.state, "queued");
  } finally {
    await close();
  }
});

function answered(body: SyncResponse): string[] {
  return [...body.documents.map((d) => d.ark), ...body.building, ...body.unavailable.map((u) => u.ark)].sort();
}

test("POST /ocr-quality/sync: bad bodies → 400 (not JSON, no arks, unknown key, > max, duplicate, non-canonical ARK)", async () => {
  const { base, deps, close } = await bootServer();
  try {
    assert.equal((await sync(base, "{ not json")).status, 400);
    assert.equal((await sync(base, { arks: [] })).status, 400);
    assert.equal((await sync(base, { nope: true })).status, 400);
    assert.equal((await sync(base, { arks: [ARK_A], extra: 1 })).status, 400, "unknown keys are refused");
    const tooMany = Array.from({ length: 101 }, (_, i) => `ark:/12148/bpt6k${i}`);
    assert.equal((await sync(base, { arks: tooMany })).status, 400);
    assert.equal((await sync(base, { arks: [ARK_A, ARK_A] })).status, 400, "duplicates are refused");
    for (const bad of [
      "https://gallica.bnf.fr/ark:/12148/x",
      ` ${ARK_A} `,
      "ark:/12148/",
      `${ARK_A}/f3`,
      "ark:/12148/bpt6k-1",
      42,
    ]) {
      assert.equal((await sync(base, { arks: [bad] })).status, 400, `rejected verbatim, never rewritten: ${String(bad)}`);
    }
    assert.equal((await deps.queue.counts(Q.ocrQualityBackfill)).queued, 0, "nothing queued by a rejected request");
  } finally {
    await close();
  }
});

test("POST /ocr-quality/sync: exactly 100 ARKs is accepted and every ARK is answered exactly once", async () => {
  const { base, close } = await bootServer();
  try {
    const arks = Array.from({ length: 100 }, (_, i) => `ark:/12148/bpt6k${i}`);
    const res = await sync(base, { arks });
    assert.equal(res.status, 200);
    assert.deepEqual(answered((await res.json()) as SyncResponse), [...arks].sort());
  } finally {
    await close();
  }
});

test("POST /ocr-quality/sync: an oversize body → 413, logged", async () => {
  const { base, lines, close } = await bootServer();
  try {
    const res = await sync(base, `{"arks":["${"x".repeat(64 * 1024)}"]}`);
    assert.equal(res.status, 413);
    assert.ok(lines.some((l) => l.event === "http_body_rejected" && l.reason === "too_large"));
  } finally {
    await close();
  }
});

test("POST /ocr-quality/sync: a corrupt artifact (wrong shape OR not JSON) is rebuilt per ARK, never a batch 500", async () => {
  const { base, deps, blob, lines, close } = await bootServer();
  try {
    await blob.putJson(keys.ocrQuality(ARK_A), { ...artifactFor(ARK_A), lane: "telepathy" });
    await blob.putBytes(keys.ocrQuality(ARK_B), Buffer.from("{ truncated", "utf8"));
    await blob.putJson(keys.ocrQuality(ARK_C), artifactFor(ARK_C));
    const res = await sync(base, { arks: [ARK_A, ARK_B, ARK_C] });
    assert.equal(res.status, 200);
    const body = (await res.json()) as SyncResponse;
    assert.deepEqual(body.documents.map((d) => d.ark), [ARK_C]);
    assert.deepEqual(body.building.sort(), [ARK_A, ARK_B].sort());
    assert.equal((await deps.queue.counts(Q.ocrQualityBackfill)).queued, 2);
    assert.equal(lines.filter((l) => l.event === "ocr_quality_artifact_corrupt").length, 2);
  } finally {
    await close();
  }
});

test("POST /ocr-quality/sync: an artifact whose folio entries break the contract is corrupt", async () => {
  const { base, blob, close } = await bootServer();
  try {
    const bad = artifactFor(ARK_A);
    bad.folios[1] = { ordre: 2, ocrSource: "alto", ocrQuality: 1.5, wordCount: 10 };
    await blob.putJson(keys.ocrQuality(ARK_A), bad);
    const body = (await (await sync(base, { arks: [ARK_A] })).json()) as SyncResponse;
    assert.deepEqual(body.documents, []);
    assert.deepEqual(body.building, [ARK_A]);
  } finally {
    await close();
  }
});

test("POST /ocr-quality/sync: a failed queue send releases the claim — retryable failure, other ARKs still answered", async () => {
  class FailingSend extends MemoryQueue {
    override async send<T>(queue: string, payload: T): Promise<void> {
      if (queue === Q.ocrQualityBackfill) throw new Error("pg-boss down");
      await super.send(queue, payload);
    }
  }
  const { base, blob, ocrBackfill, lines, close } = await bootServer({ queue: new FailingSend() });
  try {
    await blob.putJson(keys.ocrQuality(ARK_A), artifactFor(ARK_A));
    const body = (await (await sync(base, { arks: [ARK_A, ARK_B] })).json()) as SyncResponse;
    assert.deepEqual(body.documents.map((d) => d.ark), [ARK_A]);
    assert.deepEqual(body.building, []);
    assert.equal(body.unavailable.length, 1);
    assert.equal(body.unavailable[0]?.ark, ARK_B);
    assert.match(body.unavailable[0]?.reason ?? "", /^enqueue_failed: .*pg-boss down/);
    const row = await ocrBackfill.get(ARK_B);
    assert.equal(row?.state, "failed", "never stranded as queued");
    assert.equal(row?.permanent, false);
    assert.ok(lines.some((l) => l.event === "ocr_quality_enqueue_failed"));
  } finally {
    await close();
  }
});

test("POST /ocr-quality/sync: a done row whose artifact vanished is re-queued", async () => {
  const { base, deps, ocrBackfill, close } = await bootServer();
  try {
    await ocrBackfill.request(ARK_B, POLICY, new AbortController().signal);
    await ocrBackfill.markDone(ARK_B);
    const body = (await (await sync(base, { arks: [ARK_B] })).json()) as SyncResponse;
    assert.deepEqual(body.building, [ARK_B]);
    assert.equal((await deps.queue.counts(Q.ocrQualityBackfill)).queued, 1);
  } finally {
    await close();
  }
});

test("POST /ocr-quality/sync: past its deadline the request answers 503 (the app retries), logged", async () => {
  const slow: OcrBackfillStore = new (class extends MemoryOcrBackfillStore {
    override async request(ark: string, policy: OcrBackfillPolicy, signal: AbortSignal) {
      await new Promise((r) => setTimeout(r, 200));
      return super.request(ark, policy, signal);
    }
  })();
  const { base, lines, close } = await bootServer({ store: slow, syncDeadlineMs: 20 });
  try {
    const res = await sync(base, { arks: [ARK_B] });
    assert.equal(res.status, 503);
    assert.ok(lines.some((l) => l.event === "ocr_quality_sync_deadline"));
  } finally {
    await close();
  }
});

test("POST /ocr-quality/sync with the backfill disabled: missing → backfill_disabled; a stored failure and a corrupt artifact keep their own reasons; nothing queued", async () => {
  const store = new MemoryOcrBackfillStore();
  const { base, deps, blob, close } = await bootServer({ ocrBackfillEnabled: false, store });
  try {
    await blob.putJson(keys.ocrQuality(ARK_A), artifactFor(ARK_A));
    await store.request(ARK_C, POLICY, new AbortController().signal);
    await store.markFailed(ARK_C, "no_pages_artifact", { permanent: true });
    await blob.putJson(keys.ocrQuality(ARK_D), { v: 1 });

    const body = (await (await sync(base, { arks: [ARK_A, ARK_B, ARK_C, ARK_D] })).json()) as SyncResponse;
    assert.deepEqual(body.documents, [artifactFor(ARK_A)], "existing artifacts are still served");
    assert.deepEqual(body.building, []);
    assert.deepEqual(
      [...body.unavailable].sort((x, y) => x.ark.localeCompare(y.ark)),
      [
        { ark: ARK_B, reason: "backfill_disabled" },
        { ark: ARK_C, reason: "no_pages_artifact" },
        { ark: ARK_D, reason: "artifact_corrupt" },
      ].sort((x, y) => x.ark.localeCompare(y.ark)),
    );
    assert.equal((await deps.queue.counts(Q.ocrQualityBackfill)).queued, 0);
    assert.equal(await store.get(ARK_B), null, "no backfill row is opened");
  } finally {
    await close();
  }
});

test("POST /ingest: an oversize body → 413 and a body that is not JSON → 400, both logged", async () => {
  const { base, lines, close } = await bootServer();
  try {
    const big = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"pad":"${"x".repeat(9 * 1024 * 1024)}"}`,
    });
    assert.equal(big.status, 413);
    const junk = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ nope",
    });
    assert.equal(junk.status, 400);
    assert.ok(lines.some((l) => l.event === "http_body_rejected" && l.reason === "too_large"));
    assert.ok(lines.some((l) => l.event === "http_body_rejected" && l.reason === "invalid_json"));
  } finally {
    await close();
  }
});


test("POST /ocr-quality/sync: an ARK of another NAAN is answered like any other (the app's arkSchema)", async () => {
  const { base, close } = await bootServer();
  try {
    const other = "ark:/99999/bpt6k1";
    const res = await sync(base, { arks: [other] });
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as SyncResponse).building, [other]);
  } finally {
    await close();
  }
});

/** A store whose request takes `ms` before deciding — a slow database. */
function slowStore(ms: number): MemoryOcrBackfillStore {
  return new (class extends MemoryOcrBackfillStore {
    override async request(ark: string, policy: OcrBackfillPolicy, signal: AbortSignal) {
      await new Promise((r) => setTimeout(r, ms));
      return super.request(ark, policy, signal);
    }
  })();
}

test("POST /ocr-quality/sync: past the in-flight cap a request is refused 503 at once, logged", async () => {
  const { base, lines, close } = await bootServer({ store: slowStore(150) });
  try {
    const statuses = await Promise.all(
      [ARK_A, ARK_B, ARK_C].map(async (ark) => (await sync(base, { arks: [ark] })).status),
    );
    assert.deepEqual([...statuses].sort(), [200, 200, 503]);
    assert.ok(lines.some((l) => l.event === "ocr_quality_sync_busy"));
  } finally {
    await close();
  }
});

test("POST /ocr-quality/sync: the deadline cancels — the abandoned work queues nothing afterwards", async () => {
  const { base, deps, close } = await bootServer({ store: slowStore(100), syncDeadlineMs: 20 });
  try {
    assert.equal((await sync(base, { arks: [ARK_B] })).status, 503);
    await new Promise((r) => setTimeout(r, 200)); // the slow step ends after the deadline
    assert.equal((await deps.queue.counts(Q.ocrQualityBackfill)).queued, 0);
  } finally {
    await close();
  }
});

test("POST /ocr-quality/sync: a body not received in time → 408, logged", async () => {
  const { base, lines, close } = await bootServer({ bodyReadMs: 30 });
  try {
    const { port, hostname } = new URL(base);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: hostname, port, path: "/ocr-quality/sync", method: "POST", headers: { "content-length": "100" } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.write('{"arks":'); // never finished
    });
    assert.equal(status, 408);
    assert.ok(lines.some((l) => l.event === "http_body_rejected" && l.reason === "timeout"));
  } finally {
    await close();
  }
});
