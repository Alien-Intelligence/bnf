/**
 * HTTP ingress tests — drive the real Node server over a loopback socket with the
 * memory stores/queue. Covers the app contract: POST /ingest → { clusterJobId } +
 * a seeded run; GET /progress/:runId read-model + 404; /health; cancel; bad body.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { MemoryQueue } from "./core/queue-memory.js";
import { MemoryDocState } from "./domain/doc-state-memory.js";
import { MemoryRunStore } from "./domain/run-store-memory.js";
import { createMemoryLogger } from "./core/logger.js";
import { Q } from "./domain/queues.js";
import { TerminalEmitter } from "./live/progress-callback.js";
import { CompletionMonitor } from "./live/completion-monitor.js";
import { startServer, type ServerDeps } from "./server.js";

async function bootServer(): Promise<{
  base: string;
  deps: ServerDeps;
  close: () => Promise<void>;
}> {
  const queue = new MemoryQueue();
  const docState = new MemoryDocState();
  const runStore = new MemoryRunStore();
  const { logger } = createMemoryLogger();
  const emitter = new TerminalEmitter(docState, runStore, logger, {
    // Terminal POSTs in these tests just succeed; the callback path itself is
    // covered in progress-callback.test.ts.
    fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
  });
  const completion = new CompletionMonitor(docState, runStore, emitter, logger);
  const deps: ServerDeps = { runStore, docState, queue, completion, log: logger, fetchRatePerMin: 300 };
  const server = await startServer(deps, 0);
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    deps,
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
