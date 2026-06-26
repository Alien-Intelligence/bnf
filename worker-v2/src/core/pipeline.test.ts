/**
 * Unit tests for the Pipeline runner (core/pipeline.ts) — the thin composition
 * root. The runner owns nothing clever: it holds the queue transport + the list
 * of stages, starts every stage's worker loop, seeds the head queue, and stops.
 *
 * This suite proves the wiring against the memory collaborators (MemoryQueue +
 * MemoryBlobStore + memory logger) with tiny concrete stages built by extending
 * PipelineStage:
 *
 *   - a HEAD stage on Q.metadata → Q.fetch that emits one item and records the
 *     ARK it processed;
 *   - a TAIL stage on Q.fetch (no output queue) that records what it received.
 *
 * Data flows stage → stage only through the queues, so observing the tail stage's
 * record proves both stages were started and the runner wired them end to end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryBlobStore } from "./blob.js";
import { createMemoryLogger } from "./logger.js";
import { Pipeline } from "./pipeline.js";
import { MemoryQueue } from "./queue-memory.js";
import { PipelineStage, type StageDeps } from "./stage.js";
import { Q } from "../domain/queues.js";
import type { DocRef, FolioItem } from "../domain/types.js";
import type { StageContext, StageOutcome } from "./types.js";

/**
 * HEAD stage: consumes the seeded DocRef off Q.metadata, records its ark, and
 * emits one FolioItem onto Q.fetch. Stands in for the metadata stage.
 */
class HeadStage extends PipelineStage<DocRef, FolioItem> {
  readonly name = "head";
  readonly inputQueue = Q.metadata;
  override readonly outputQueue = Q.fetch;
  override readonly concurrency = 1;

  /** ARKs seen by process(), in arrival order. */
  readonly seen: string[] = [];

  override async process(payload: DocRef, _ctx: StageContext): Promise<StageOutcome<FolioItem>> {
    this.seen.push(payload.ark);
    return {
      kind: "emit",
      items: [{ docJobId: payload.docJobId, ark: payload.ark, ordre: 1, kind: "alto", lane: "text" }],
    };
  }
}

/**
 * TAIL stage: consumes FolioItems off Q.fetch and records them. No output queue —
 * it's the terminal stage. Its records prove data flowed all the way through.
 */
class TailStage extends PipelineStage<FolioItem, never> {
  readonly name = "tail";
  readonly inputQueue = Q.fetch;
  override readonly concurrency = 1;

  /** Every FolioItem this stage received. */
  readonly received: FolioItem[] = [];

  override async process(payload: FolioItem, _ctx: StageContext): Promise<StageOutcome<never>> {
    this.received.push(payload);
    return { kind: "done" };
  }
}

/** Stand up the shared collaborators (one MemoryQueue + memory blob + memory logger). */
function deps(): {
  deps: StageDeps;
  queue: MemoryQueue;
  lines: Array<Record<string, unknown>>;
} {
  const { logger, lines } = createMemoryLogger();
  const blob = new MemoryBlobStore();
  const queue = new MemoryQueue();
  return { deps: { queue, blob, log: logger }, queue, lines };
}

const DOC: DocRef = { projectId: "p1", docJobId: "d1", ark: "ark:/12148/btv1b1" };

test("start() starts every stage — data flows head → tail through the runner", async () => {
  const d = deps();
  const head = new HeadStage(d.deps);
  const tail = new TailStage(d.deps);
  const pipeline = new Pipeline(d.queue, [head, tail], d.deps.log);

  await pipeline.start();

  // Seed the head queue directly, then let the whole pipeline drain.
  await d.queue.send(Q.metadata, DOC);
  await d.queue.idle();

  assert.deepEqual(head.seen, [DOC.ark], "head stage started and processed the seeded DocRef");
  assert.equal(tail.received.length, 1, "tail stage started and received the emitted item");
  assert.equal(tail.received[0]?.ark, DOC.ark, "the item that reached the tail carries the same ARK");

  const startedLog = d.lines.find((l) => l.event === "pipeline_started");
  assert.ok(startedLog, "pipeline_started was logged");
  assert.deepEqual(startedLog?.stages, ["head", "tail"], "both stage names logged at start");
});

test("seed() enqueues to Q.metadata — the head stage processes the DocRef", async () => {
  const d = deps();
  const head = new HeadStage(d.deps);
  const tail = new TailStage(d.deps);
  const pipeline = new Pipeline(d.queue, [head, tail], d.deps.log);

  await pipeline.start();
  await pipeline.seed([DOC]);
  await d.queue.idle();

  assert.deepEqual(head.seen, [DOC.ark], "seed() landed the DocRef on Q.metadata → head processed it");
  assert.equal(tail.received.length, 1, "and it flowed on to the tail");

  const seededLog = d.lines.find((l) => l.event === "pipeline_seeded");
  assert.ok(seededLog, "pipeline_seeded was logged");
  assert.equal(seededLog?.count, 1, "seeded count logged");
});

test("seed([]) is a no-op — nothing enqueued, nothing processed, no throw", async () => {
  const d = deps();
  const head = new HeadStage(d.deps);
  const tail = new TailStage(d.deps);
  const pipeline = new Pipeline(d.queue, [head, tail], d.deps.log);

  await pipeline.start();
  await pipeline.seed([]); // must not throw
  await d.queue.idle();

  const counts = await d.queue.counts(Q.metadata);
  assert.equal(counts.queued, 0, "no item queued on Q.metadata");
  assert.equal(counts.running, 0, "no item running on Q.metadata");
  assert.equal(counts.completed, 0, "no item completed on Q.metadata");
  assert.equal(counts.failed, 0, "no item failed on Q.metadata");
  assert.deepEqual(head.seen, [], "head stage saw nothing");

  const seededLog = d.lines.find((l) => l.event === "pipeline_seeded");
  assert.equal(seededLog, undefined, "empty seed does not even log pipeline_seeded");
});

test("double start() throws", async () => {
  const d = deps();
  const head = new HeadStage(d.deps);
  const tail = new TailStage(d.deps);
  const pipeline = new Pipeline(d.queue, [head, tail], d.deps.log);

  await pipeline.start();
  await assert.rejects(() => pipeline.start(), /already started/, "second start() rejects");
});

test("duplicate input queue is rejected at construction", () => {
  const d = deps();
  // Two stages both bound to Q.metadata → ambiguous worker registration.
  const a = new HeadStage(d.deps);
  const b = new HeadStage(d.deps);
  assert.throws(
    () => new Pipeline(d.queue, [a, b], d.deps.log),
    /same input queue/,
    "constructing with two stages on the same input queue throws",
  );
});

test("stop() stops the queue — workers cleared, a later send is not processed", async () => {
  const d = deps();
  const head = new HeadStage(d.deps);
  const tail = new TailStage(d.deps);
  const pipeline = new Pipeline(d.queue, [head, tail], d.deps.log);

  await pipeline.start();
  await pipeline.stop();

  // MemoryQueue.stop() clears all registered workers. A subsequent send therefore
  // has no worker to pick it up — it stays queued and the head stage never sees it.
  await d.queue.send(Q.metadata, DOC);
  // Give any (incorrectly surviving) worker a chance to run before asserting.
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(head.seen, [], "no worker processed the post-stop send");
  const counts = await d.queue.counts(Q.metadata);
  assert.equal(counts.queued, 1, "the item is still sitting queued — no worker drained it");
  assert.equal(counts.completed, 0, "nothing completed after stop");

  const stoppedLog = d.lines.find((l) => l.event === "pipeline_stopped");
  assert.ok(stoppedLog, "pipeline_stopped was logged");
});
