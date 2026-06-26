/**
 * End-to-end wiring proof (fake clients, real pipeline + real run/completion/emit):
 * the ingress seeds a run, the docs walk every stage, and the completion monitor —
 * wired to the pipeline's onOutcome — fires ONE terminal callback whose stats
 * reconcile. This is the fake-mode version of the goal's acceptance gate for the
 * app↔worker callback contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPipeline } from "../build.js";
import { MemoryQueue } from "../core/queue-memory.js";
import { MemoryBlobStore } from "../core/blob.js";
import { createMemoryLogger } from "../core/logger.js";
import { MemoryDocState } from "../domain/doc-state-memory.js";
import { MemoryRunStore } from "../domain/run-store-memory.js";
import {
  FakeBnfClient,
  FakeClusterSink,
  FakeDescriber,
  FakeEmbedder,
  FakeOcrEngine,
  type FakeDocSpec,
} from "../testing/fakes.js";
import { TerminalEmitter } from "./progress-callback.js";
import { CompletionMonitor } from "./completion-monitor.js";
import { createRunAndSeed, parseIngestRequest } from "./ingress.js";

function buildHarness(specs: FakeDocSpec[]) {
  const queue = new MemoryQueue();
  const blob = new MemoryBlobStore();
  const { logger } = createMemoryLogger();
  const docState = new MemoryDocState();
  const runStore = new MemoryRunStore();
  const bnf = new FakeBnfClient();
  for (const s of specs) bnf.add(s);

  const posts: Array<Record<string, unknown>> = [];
  const emitter = new TerminalEmitter(docState, runStore, logger, {
    fetchFn: (async (_url, init) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  const completion = new CompletionMonitor(docState, runStore, emitter, logger);

  const pipeline = buildPipeline({
    queue,
    blob,
    log: logger,
    bnf,
    docState,
    describer: new FakeDescriber(),
    ocr: new FakeOcrEngine(),
    embedder: new FakeEmbedder(),
    cluster: new FakeClusterSink(),
    onOutcome: (e) => completion.noteOutcome({ kind: e.kind, payload: e.payload }),
    config: { mistralEnabled: true, maxPages: 200 },
  });

  return { queue, docState, runStore, completion, posts, pipeline };
}

const body = (arks: string[]) => ({
  projectId: "p1",
  targetVersionId: "v2",
  appJobId: "job-1",
  added: arks.map((ark) => ({ ark })),
  removed: [],
  callbackUrl: "http://127.0.0.1:1/api/internal/ingest/job-1/progress",
  callbackSecret: "s3cr3t",
});

test("ingress → full pipeline → exactly one terminal 'done' callback that reconciles", async () => {
  const h = buildHarness([
    { ark: "ark:/12148/textdoc", ocrAvailable: true, docType: "texte", pageCount: 3 },
    { ark: "ark:/12148/visiondoc", ocrAvailable: false, docType: "estampe", pageCount: 3 },
    { ark: "ark:/12148/mistraldoc", ocrAvailable: false, docType: "texte", pageCount: 3 },
  ]);
  await h.pipeline.start();

  const parsed = parseIngestRequest(body([
    "ark:/12148/textdoc",
    "ark:/12148/visiondoc",
    "ark:/12148/mistraldoc",
  ]));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  await createRunAndSeed({ runStore: h.runStore, docState: h.docState, queue: h.queue }, parsed.value);

  await h.queue.idle();
  // The completion check is detached (fire-and-forget); let it settle.
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(h.posts.length, 1, `exactly one terminal callback, got ${h.posts.length}`);
  const event = h.posts[0]!;
  assert.equal(event.stage, "done");
  const stats = event.stats as { total: number; done: number; failed: number; skipped: number };
  assert.equal(stats.done, 3);
  assert.equal(stats.failed, 0);
  assert.equal(stats.total, 3);
});

test("a run with a hard-failing doc → terminal 'done' partial with the failed ark in errors[]", async () => {
  const h = buildHarness([
    { ark: "ark:/12148/ok", ocrAvailable: true, docType: "texte", pageCount: 2 },
    {
      ark: "ark:/12148/lossy",
      ocrAvailable: true,
      docType: "texte",
      pageCount: 4,
      folioFaults: {
        1: { alwaysTransient: true, status: 500 },
        2: { alwaysTransient: true, status: 500 },
      }, // 2/4 lost > 25% → fail-ratio trip
    },
  ]);
  await h.pipeline.start();

  const parsed = parseIngestRequest(body(["ark:/12148/ok", "ark:/12148/lossy"]));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  await createRunAndSeed({ runStore: h.runStore, docState: h.docState, queue: h.queue }, parsed.value);

  await h.queue.idle();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(h.posts.length, 1);
  const event = h.posts[0]!;
  assert.equal(event.stage, "done"); // one success → pointer still advances (partial)
  const stats = event.stats as {
    done: number;
    failed: number;
    errors: Array<{ ark: string }>;
  };
  assert.equal(stats.done, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.errors[0]?.ark, "ark:/12148/lossy");
});
