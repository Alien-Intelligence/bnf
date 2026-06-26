/**
 * Terminal callback tests — the event-shape rules (done / partial / all-failed),
 * the HMAC signature the app verifier accepts, the run-store latch (one emit), and
 * the release-on-failure path. No network: fetch is injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { MemoryDocState } from "../domain/doc-state-memory.js";
import { MemoryRunStore } from "../domain/run-store-memory.js";
import { createMemoryLogger } from "../core/logger.js";
import type { IngestRun } from "../domain/run.js";
import {
  buildTerminalEvent,
  signBody,
  TerminalEmitter,
} from "./progress-callback.js";

const zeroCounts = () => ({
  queued: 0, planned: 0, fetching: 0, ready: 0, processing: 0,
  done: 0, failed: 0, skipped: 0, excluded: 0,
});

/** Re-implements the app's verifyCallback to assert v2's signature is acceptable. */
function appVerifies(body: string, signature: string, secret: string): boolean {
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

test("buildTerminalEvent: all done → stage done, failed=0, no errors", () => {
  const event = buildTerminalEvent({
    totalDocs: 3,
    counts: { ...zeroCounts(), done: 3 },
    failedDocs: [],
    chunksWritten: 12,
  });
  assert.equal(event.stage, "done");
  if (event.stage !== "done") return;
  assert.equal(event.chunksWritten, 12);
  assert.equal(event.stats.failed, 0);
  assert.deepEqual(event.stats.errors, []);
});

test("buildTerminalEvent: partial → stage done with errors[] for each failed doc", () => {
  const event = buildTerminalEvent({
    totalDocs: 3,
    counts: { ...zeroCounts(), done: 2, failed: 1 },
    failedDocs: [{ ark: "ark:/12148/bad", lane: "text", error: "page-fail-ratio 3/4" }],
    chunksWritten: 8,
  });
  assert.equal(event.stage, "done"); // partial still advances the pointer
  if (event.stage !== "done") return;
  assert.equal(event.stats.failed, 1);
  assert.deepEqual(event.stats.errors, [
    { ark: "ark:/12148/bad", stage: "text", reason: "page-fail-ratio 3/4" },
  ]);
});

test("buildTerminalEvent: every doc failed → stage failed (pointer left behind)", () => {
  const event = buildTerminalEvent({
    totalDocs: 2,
    counts: { ...zeroCounts(), failed: 2 },
    failedDocs: [
      { ark: "ark:/12148/a", lane: "vision", error: "manifest 500" },
      { ark: "ark:/12148/b", lane: null, error: null },
    ],
    chunksWritten: 0,
  });
  assert.equal(event.stage, "failed");
  if (event.stage !== "failed") return;
  assert.equal(event.partialStats.failed, 2);
  assert.equal(event.partialStats.errors[1]?.stage, "unknown");
  assert.equal(event.partialStats.errors[1]?.reason, "échec");
});

test("buildTerminalEvent: only skipped (no done, no failed) → stage done (no-op success)", () => {
  const event = buildTerminalEvent({
    totalDocs: 2,
    counts: { ...zeroCounts(), skipped: 2 },
    failedDocs: [],
    chunksWritten: 0,
  });
  assert.equal(event.stage, "done");
  if (event.stage !== "done") return;
  assert.equal(event.stats.skipped, 2);
  assert.equal(event.stats.failed, 0);
});

function run(overrides: Partial<IngestRun> = {}): IngestRun {
  return {
    runId: "run-1",
    appJobId: "job-1",
    projectId: "p1",
    callbackUrl: "https://app.example/api/internal/ingest/job-1/progress",
    callbackSecret: "s3cr3t",
    targetVersionId: "v2",
    totalDocs: 1,
    terminalEmitted: false,
    canceled: false,
    ...overrides,
  };
}

test("emit POSTs a signature the app verifier accepts, then latches", async () => {
  const docState = new MemoryDocState();
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/a", runId: "run-1" });
  await docState.setStatus("d1", "done");
  const runStore = new MemoryRunStore();
  await runStore.create(run());
  const { logger } = createMemoryLogger();

  const captures: Array<{ url: string; body: string; sig: string | null }> = [];
  const fetchFn = (async (url, init) => {
    captures.push({
      url: String(url),
      body: String(init?.body),
      sig: new Headers(init?.headers).get("x-callback-signature"),
    });
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  }) as typeof fetch;

  const emitter = new TerminalEmitter(docState, runStore, logger, { fetchFn });
  const r = (await runStore.get("run-1"))!;
  const emitted = await emitter.emit(r);

  assert.equal(emitted, true);
  assert.equal(captures.length, 1);
  const cap = captures[0]!;
  assert.equal(cap.url, r.callbackUrl);
  assert.ok(cap.sig);
  assert.equal(signBody(cap.body, "s3cr3t"), cap.sig);
  assert.equal(appVerifies(cap.body, cap.sig!, "s3cr3t"), true);

  // Latched — a second emit does not POST again.
  const again = await emitter.emit((await runStore.get("run-1"))!);
  assert.equal(again, false);
});

test("emit releases the latch and throws when the callback never succeeds", async () => {
  const docState = new MemoryDocState();
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/a", runId: "run-1" });
  await docState.setStatus("d1", "done");
  const runStore = new MemoryRunStore();
  await runStore.create(run());
  const { logger } = createMemoryLogger();

  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return new Response("nope", { status: 500 });
  }) as typeof fetch;

  const emitter = new TerminalEmitter(docState, runStore, logger, {
    fetchFn,
    maxAttempts: 2,
    backoffMs: 1,
  });

  const r = (await runStore.get("run-1"))!;
  await assert.rejects(() => emitter.emit(r));
  assert.equal(calls, 2); // retried up to maxAttempts
  // Latch released → a later check can retry.
  assert.equal((await runStore.get("run-1"))?.terminalEmitted, false);
});
