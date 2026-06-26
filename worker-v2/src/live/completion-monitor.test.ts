/**
 * Completion-monitor tests — the run-completion → single-terminal-callback rule,
 * driven through the real TerminalEmitter with an injected fetch (so the HMAC POST
 * path is exercised too). Confirms: emit-kind outcomes are ignored, a run fires
 * exactly once when all its docs are terminal, an in-flight run does not fire, and
 * a zero-doc run fires immediately via checkRun.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryDocState } from "../domain/doc-state-memory.js";
import { MemoryRunStore } from "../domain/run-store-memory.js";
import { createMemoryLogger } from "../core/logger.js";
import { TerminalEmitter } from "./progress-callback.js";
import { CompletionMonitor } from "./completion-monitor.js";

interface Posted {
  body: string;
}

function wire() {
  const docState = new MemoryDocState();
  const runStore = new MemoryRunStore();
  const { logger } = createMemoryLogger();
  const posts: Posted[] = [];
  const fetchFn = (async (_url, init) => {
    posts.push({ body: String(init?.body) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const emitter = new TerminalEmitter(docState, runStore, logger, { fetchFn });
  const monitor = new CompletionMonitor(docState, runStore, emitter, logger);
  return { docState, runStore, monitor, posts };
}

const baseRun = (runId: string, totalDocs: number) => ({
  runId,
  appJobId: `app-${runId}`,
  projectId: "p1",
  callbackUrl: `https://app.example/api/internal/ingest/app-${runId}/progress`,
  callbackSecret: "s3cr3t",
  targetVersionId: "v2",
  totalDocs,
});

/** Await the detached completion check kicked off by noteOutcome. */
const settle = () => new Promise((r) => setTimeout(r, 5));

test("noteOutcome ignores emit-kind outcomes (no work, no emit)", async () => {
  const { runStore, monitor, posts } = wire();
  await runStore.create(baseRun("r1", 1));
  monitor.noteOutcome({ kind: "emit", payload: { docJobId: "d1" } });
  await settle();
  assert.equal(posts.length, 0);
});

test("a run fires its terminal callback exactly once when all docs are terminal", async () => {
  const { docState, runStore, monitor, posts } = wire();
  await runStore.create(baseRun("r1", 2));
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/a", runId: "r1" });
  await docState.upsertDoc({ docJobId: "d2", projectId: "p1", ark: "ark:/12148/b", runId: "r1" });

  // First doc done — run still in flight (d2 not terminal) → no emit.
  await docState.setStatus("d1", "done");
  monitor.noteOutcome({ kind: "done", payload: { docJobId: "d1" } });
  await settle();
  assert.equal(posts.length, 0);

  // Second doc failed — run now fully terminal → exactly one emit.
  await docState.setStatus("d2", "failed", { error: "boom" });
  monitor.noteOutcome({ kind: "done", payload: { docJobId: "d2" } });
  await settle();
  assert.equal(posts.length, 1);

  const event = JSON.parse(posts[0]!.body);
  assert.equal(event.stage, "done"); // 1 done > 0 → partial still commits
  assert.equal(event.stats.failed, 1);
  assert.equal(event.stats.errors[0].ark, "ark:/12148/b");

  // A redundant later outcome does not double-fire (latched).
  monitor.noteOutcome({ kind: "done", payload: { docJobId: "d2" } });
  await settle();
  assert.equal(posts.length, 1);
});

test("checkDoc on a non-terminal doc does no run check (no emit)", async () => {
  const { docState, runStore, monitor, posts } = wire();
  await runStore.create(baseRun("r1", 1));
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/a", runId: "r1" });
  await docState.setStatus("d1", "ready"); // intermediate, not terminal
  monitor.noteOutcome({ kind: "done", payload: { docJobId: "d1" } });
  await settle();
  assert.equal(posts.length, 0);
});

test("a zero-doc (removal-only) run fires immediately via checkRun", async () => {
  const { runStore, monitor, posts } = wire();
  await runStore.create(baseRun("r1", 0));
  await monitor.checkRun("r1");
  assert.equal(posts.length, 1);
  const event = JSON.parse(posts[0]!.body);
  assert.equal(event.stage, "done");
  assert.equal(event.stats.total, 0);
});
