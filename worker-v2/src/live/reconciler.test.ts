/**
 * Reconciler tests — the "no run can wedge" guarantees, one test per orphan class.
 *
 * The whole point of the sweep is that it acts when NOTHING else will, so every
 * test here sets up a doc whose queue job is simply absent (no worker consumes the
 * buckets — MemoryQueue holds the message in `queued`, which the tests then read
 * back to assert exactly what was re-driven) and checks the sweep re-drives it
 * onto the right bucket, with the right payload, exactly once.
 *
 * Covered: orphaned queued / planned / ready docs, a doc that still HAS a live job
 * (must be untouched), the requeue cap, run completion via the terminal latch, and
 * the no-overlap guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryBlobStore } from "../core/blob.js";
import { createMemoryLogger } from "../core/logger.js";
import { MemoryQueue } from "../core/queue-memory.js";
import { MemoryDocState } from "../domain/doc-state-memory.js";
import { MemoryRunStore } from "../domain/run-store-memory.js";
import { keys } from "../domain/keys.js";
import { Q } from "../domain/queues.js";
import type { DocMeta, DocReady, DocRef, FolioItem, FolioResult } from "../domain/types.js";
import { CompletionMonitor } from "./completion-monitor.js";
import { TerminalEmitter } from "./progress-callback.js";
import { Reconciler, STRANDED_ERROR } from "./reconciler.js";

const META: DocMeta = {
  title: "Le Journal",
  creator: null,
  date: "1949",
  docType: "fascicule",
  subtype: null,
  lang: "fre",
  pageCount: 5,
  ocrAvailable: true,
};

function wire() {
  const docState = new MemoryDocState();
  const runStore = new MemoryRunStore();
  const queue = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const { logger, lines } = createMemoryLogger();
  const posts: string[] = [];
  const fetchFn = (async (_url, init) => {
    posts.push(String(init?.body));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const completion = new CompletionMonitor(
    docState,
    runStore,
    new TerminalEmitter(docState, runStore, logger, { fetchFn }),
    logger,
  );
  const reconciler = new Reconciler(
    { runStore, docState, queue, blob, completion, log: logger },
    { maxRequeues: 3 },
  );
  return { docState, runStore, queue, blob, completion, reconciler, posts, lines };
}

const run = (runId: string, totalDocs: number) => ({
  runId,
  appJobId: `app-${runId}`,
  projectId: "p1",
  callbackUrl: "https://app.example/api/internal/ingest/app-1/progress",
  callbackSecret: "s3cr3t",
  targetVersionId: "v7",
  totalDocs,
});

/**
 * Everything the sweep enqueued onto a bucket. Nothing consumes the buckets in
 * these tests (that IS the scenario), so the payloads sit there and can be read
 * back verbatim with MemoryQueue's side-effect-free inspector.
 */
function pending<T>(queue: MemoryQueue, name: string): T[] {
  return queue.pending<T>(name);
}

test("orphaned 'queued' doc → re-seeded onto the metadata bucket, requeues = 1", async () => {
  const { docState, runStore, queue, reconciler } = wire();
  await runStore.create(run("r1", 1));
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/a", runId: "r1" });

  const summary = await reconciler.sweep();

  assert.deepEqual(summary, {
    runs: 1,
    docs: 1,
    orphans: 1,
    requeued: 1,
    failed: 0,
    emitted: 0,
  });
  assert.equal((await docState.get("d1"))?.requeues, 1, "the re-drive was counted");
  assert.deepEqual(
    pending<DocRef>(queue, Q.metadata),
    [{ projectId: "p1", docJobId: "d1", ark: "ark:/12148/a", runId: "r1" }],
    "the exact DocRef shape the ingress seeds",
  );
});

test("a doc swept past the requeue cap fails terminally with stranded_after_requeues", async () => {
  const { docState, runStore, queue, reconciler, posts } = wire();
  await runStore.create(run("r1", 1));
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/a", runId: "r1" });

  // The pathological case: the job VANISHES every time it is enqueued (a pg-boss
  // expiration in a crash-looping pod). Faked at the liveness seam, since that is
  // exactly what the sweep observes — a doc with no live job, over and over.
  queue.liveDocJobIds = async () => new Set<string>();

  for (let i = 0; i < 4; i++) await reconciler.sweep();

  const row = await docState.get("d1");
  assert.equal(row?.status, "failed", "the doc is terminal, so the run can complete");
  assert.equal(row?.requeues, 3, "re-driven exactly maxRequeues times, then failed");
  assert.match(String(row?.error), new RegExp(`^${STRANDED_ERROR}: queued requeued 3x`));
  assert.equal(
    pending<DocRef>(queue, Q.metadata).length,
    3,
    "three re-drives were sent, and the fourth sweep sent nothing",
  );

  // And the run now completes on its own — that is the whole point of failing it.
  await reconciler.sweep();
  assert.equal(posts.length, 1, "terminal callback fired once the last doc went terminal");
});

test("a doc WITH a live job is left completely alone", async () => {
  const { docState, runStore, queue, reconciler } = wire();
  await runStore.create(run("r1", 1));
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/a", runId: "r1" });
  // Its metadata job is sitting on the bucket, unconsumed but very much alive.
  await queue.send(Q.metadata, { projectId: "p1", docJobId: "d1", ark: "ark:/12148/a", runId: "r1" });

  const summary = await reconciler.sweep();

  assert.equal(summary.orphans, 0, "a live job means not an orphan");
  assert.equal(summary.requeued, 0);
  assert.equal((await docState.get("d1"))?.requeues, 0, "no re-drive was counted");
  assert.equal((pending<DocRef>(queue, Q.metadata)).length, 1, "no duplicate was sent");
});

test("orphaned 'planned' doc → only the MISSING folios are re-enqueued (right kind/lane/priority)", async () => {
  const { docState, runStore, queue, reconciler } = wire();
  await runStore.create(run("r1", 1));
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/a", runId: "r1" });
  await docState.recordPlan("d1", { lane: "text", pagesExpected: 5, meta: META });
  // 2 of 5 folios landed — one ok, one LOST. A lost folio already reached the
  // Monitor's counter, so it must NOT be re-fetched.
  await docState.recordFolio("d1", 1, true);
  await docState.recordFolio("d1", 2, false);

  const summary = await reconciler.sweep();
  assert.equal(summary.requeued, 1, "one doc re-driven");

  const items = pending<FolioItem & { priority: number }>(queue, Q.fetch);
  assert.deepEqual(
    items.map((i) => i.ordre),
    [3, 4, 5],
    "exactly the three ordres with no folio row",
  );
  for (const it of items) {
    assert.equal(it.kind, "alto", "text lane fetches ALTO");
    assert.equal(it.lane, "text");
    assert.equal(it.priority, 10, "text-lane fetch priority, same as the metadata fan-out");
    assert.equal(it.docJobId, "d1");
    assert.equal(it.ark, "ark:/12148/a");
  }
});

test("orphaned 'planned' image-lane doc → folio ordres come from the CACHED MANIFEST", async () => {
  const { docState, runStore, queue, blob, reconciler } = wire();
  await runStore.create(run("r1", 1));
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/img", runId: "r1" });
  await docState.recordPlan("d1", { lane: "mistral", pagesExpected: 3, meta: META });
  await docState.recordFolio("d1", 7, true);
  // Canvas ordres are NOT 1..N — they come from the IIIF canvas id (f7/f9/f11), so
  // rebuilding them by counting would fetch folios that do not exist.
  await blob.putJson(keys.manifest("ark:/12148/img"), {
    title: "img",
    metadata: [],
    totalPages: 3,
    canvases: [
      { ordre: 7, label: "f7", width: 1, height: 1 },
      { ordre: 9, label: "f9", width: 1, height: 1 },
      { ordre: 11, label: "f11", width: 1, height: 1 },
    ],
  });

  await reconciler.sweep();

  const items = pending<FolioItem & { priority: number }>(queue, Q.fetch);
  assert.deepEqual(items.map((i) => i.ordre), [9, 11]);
  assert.equal(items[0]?.kind, "image", "image lanes fetch images");
  assert.equal(items[0]?.priority, 100, "mistral-lane priority");
});

test("orphaned 'planned' image doc with NO cached manifest → re-driven through the manifest stage", async () => {
  const { docState, runStore, queue, reconciler } = wire();
  await runStore.create(run("r1", 1));
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/img", runId: "r1" });
  await docState.recordPlan("d1", { lane: "vision", pagesExpected: 3, meta: META });

  await reconciler.sweep();

  const reqs = pending<{ docJobId: string; lane: string }>(queue, Q.manifest);
  assert.equal(reqs.length, 1, "no ordres to derive → the stage that derives them re-runs");
  assert.equal(reqs[0]?.lane, "vision");
  assert.equal((pending(queue, Q.fetch)).length, 0, "no folios guessed");
});

test("orphaned 'planned' doc whose folios ALL landed → the fan-in is kicked, not re-fetched", async () => {
  const { docState, runStore, queue, reconciler } = wire();
  await runStore.create(run("r1", 1));
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/a", runId: "r1" });
  await docState.recordPlan("d1", { lane: "text", pagesExpected: 2, meta: META });
  await docState.recordFolio("d1", 1, true);
  await docState.recordFolio("d1", 2, true);

  await reconciler.sweep();

  assert.equal((pending(queue, Q.fetch)).length, 0, "nothing to re-fetch");
  const results = pending<FolioResult>(queue, Q.monitor);
  assert.equal(results.length, 1, "one folio result replayed to re-run the fan-in");
  assert.deepEqual(results[0], {
    docJobId: "d1",
    ark: "ark:/12148/a",
    ordre: 2,
    lane: "text",
    ok: true,
  });
});

test("orphaned 'ready' doc → the lane DocReady is rebuilt with its ok folios, in order", async () => {
  const { docState, runStore, queue, reconciler } = wire();
  await runStore.create(run("r1", 1));
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/a", runId: "r1" });
  await docState.recordPlan("d1", { lane: "mistral", pagesExpected: 3, meta: META });
  await docState.recordFolio("d1", 3, true);
  await docState.recordFolio("d1", 1, true);
  await docState.recordFolio("d1", 2, false); // lost → not a usable page
  await docState.claimRoute("d1", "ready");

  await reconciler.sweep();

  const ready = pending<DocReady>(queue, Q.ocrSubmit);
  assert.equal(ready.length, 1, "re-sent onto the mistral lane's queue");
  assert.deepEqual(ready[0], {
    projectId: "p1",
    docJobId: "d1",
    ark: "ark:/12148/a",
    runId: "r1",
    lane: "mistral",
    pagesExpected: 3,
    meta: META,
    folios: [1, 3],
  });
  assert.equal((pending(queue, Q.assemble)).length, 0, "not the wrong lane");
});

test("a run whose docs are all terminal but un-emitted fires its callback exactly once", async () => {
  const { docState, runStore, reconciler, posts } = wire();
  await runStore.create(run("r1", 2));
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/a", runId: "r1" });
  await docState.upsertDoc({ docJobId: "d2", projectId: "p1", ark: "ark:/12148/b", runId: "r1" });
  await docState.setStatus("d1", "done");
  await docState.setStatus("d2", "failed", { error: "boom" });

  const first = await reconciler.sweep();
  assert.equal(first.emitted, 1, "the sweep noticed a completion nothing else would have");
  assert.equal(first.orphans, 0, "terminal docs are not sweep candidates");
  assert.equal(posts.length, 1);
  const event = JSON.parse(posts[0]!);
  assert.equal(event.stage, "done");
  assert.equal(event.stats.failed, 1);

  // Latched: the run is no longer active, so a second sweep does nothing at all.
  const second = await reconciler.sweep();
  assert.deepEqual(second, { runs: 0, docs: 0, orphans: 0, requeued: 0, failed: 0, emitted: 0 });
  assert.equal(posts.length, 1);
});

test("a canceled run is not swept (no re-drives, no callback)", async () => {
  const { docState, runStore, queue, reconciler, posts } = wire();
  await runStore.create(run("r1", 1));
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/a", runId: "r1" });
  await runStore.markCanceled("r1");

  const summary = await reconciler.sweep();

  assert.equal(summary.runs, 0, "a canceled run is not active");
  assert.equal((pending(queue, Q.metadata)).length, 0, "its orphan is left alone");
  assert.equal(posts.length, 0);
});

test("tick() never overlaps itself — a tick during a slow sweep is skipped, not queued", async () => {
  const { docState, runStore, reconciler, lines } = wire();
  await runStore.create(run("r1", 1));
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/a", runId: "r1" });

  // Gate the first thing the sweep does, so the sweep is provably in flight.
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const realList = runStore.listActiveRuns.bind(runStore);
  runStore.listActiveRuns = async () => {
    calls += 1;
    await gate;
    return await realList();
  };

  const first = reconciler.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1, "the first sweep is in flight");

  await reconciler.tick(); // lands mid-sweep → skipped outright
  assert.equal(calls, 1, "the second tick did NOT start a second sweep");
  assert.ok(
    lines.find((l) => l.event === "reconciler_tick_skipped"),
    "the skip is logged, not silent",
  );

  release();
  await first;
  assert.equal(calls, 1, "still exactly one sweep ran");

  // Once the first finished, a later tick runs normally.
  await reconciler.tick();
  assert.equal(calls, 2);
});

test("a sweep that throws is contained: tick() resolves, logs, and the next tick still runs", async () => {
  const { runStore, reconciler, lines } = wire();
  let calls = 0;
  runStore.listActiveRuns = async () => {
    calls += 1;
    throw new Error("db unreachable");
  };

  await reconciler.tick();
  assert.ok(
    lines.find((l) => l.event === "reconciler_sweep_failed"),
    "the failure is logged",
  );

  await reconciler.tick();
  assert.equal(calls, 2, "the in-flight guard was released even though the sweep threw");
});

test("a quiet sweep logs nothing (no 60s heartbeat spam)", async () => {
  const { docState, runStore, reconciler, lines } = wire();
  await runStore.create(run("r1", 1));
  await docState.upsertDoc({ docJobId: "d1", projectId: "p1", ark: "ark:/12148/a", runId: "r1" });
  await docState.setStatus("d1", "done"); // terminal doc, run not complete (total 1 → it IS)

  const before = lines.length;
  await runStore.markTerminalEmitted("r1"); // nothing left to do at all
  await reconciler.sweep();

  assert.equal(lines.length, before, "a sweep with no action emits no log line");
});
