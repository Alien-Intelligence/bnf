/**
 * Unit tests for PipelineStage (core/stage.ts) — the framework's core lifecycle.
 *
 * The base owns the identical-for-every-stage flow so a concrete stage only writes
 * `process()`. This suite proves that flow end-to-end against the memory
 * collaborators (MemoryQueue + MemoryBlobStore + memory logger):
 *
 *   consume → [cache hit ⇒ skip process(), re-dispatch cached outcome]
 *           → rate.acquire() (if rate-capped)
 *           → process()
 *           → persist outcome to blob (emit|done) so a replay resumes
 *           → dispatch: emit → outputQueue | done | skip | fail(retry|terminal)
 *
 * Every test drives real delivery: wire the stage, `start()`, `send()` the input,
 * `await queue.idle()`, then assert on queue counts / collected emits / blob state /
 * log lines / process call count.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryBlobStore } from "./blob.js";
import { createMemoryLogger } from "./logger.js";
import { MemoryQueue } from "./queue-memory.js";
import { PipelineStage, type StageDeps } from "./stage.js";
import type { QueueMessage, RateGate, StageContext, StageOutcome } from "./types.js";

const IN_Q = "in";
const OUT_Q = "out";

interface Item {
  ark: string;
}

/**
 * A configurable concrete stage. `process()` returns whatever `outcomeFor`
 * produces (defaulting to a fixed outcome) and records every call so tests can
 * assert how many times the work actually ran.
 */
class TestStage extends PipelineStage<Item, Item> {
  readonly name = "test-stage";
  readonly inputQueue = IN_Q;
  readonly outputQueue?: string;
  readonly concurrency = 1; // deterministic ordering for assertions
  readonly rate?: RateGate;

  /** Records the payload of every process() invocation. */
  readonly processed: Item[] = [];
  /** Records onExhausted calls (payload + reason) — the run-completion safety net. */
  readonly exhausted: Array<{ payload: Item; reason: string }> = [];

  private readonly outcomeFor: (payload: Item) => StageOutcome<Item>;
  private readonly keyFor: (payload: Item) => string | null;

  constructor(opts: {
    deps: StageDeps;
    outcome?: StageOutcome<Item> | ((payload: Item) => StageOutcome<Item>);
    outputQueue?: string;
    rate?: RateGate;
    retryAttempts?: number;
    artifactKey?: (payload: Item) => string | null;
  }) {
    super(opts.deps);
    this.outputQueue = opts.outputQueue;
    this.rate = opts.rate;
    if (opts.retryAttempts !== undefined) {
      this.retry = { attempts: opts.retryAttempts, baseMs: 1, maxDelayMs: 1 };
    }
    const o = opts.outcome ?? ({ kind: "done" } as StageOutcome<Item>);
    this.outcomeFor = typeof o === "function" ? o : () => o;
    this.keyFor = opts.artifactKey ?? (() => null);
  }

  // `retry` is `readonly` on the base; the constructor reassigns it before start().
  declare readonly retry: PipelineStage<Item, Item>["retry"];

  override artifactKey(payload: Item): string | null {
    return this.keyFor(payload);
  }

  override async process(payload: Item, _ctx: StageContext): Promise<StageOutcome<Item>> {
    this.processed.push(payload);
    return this.outcomeFor(payload);
  }

  protected override async onExhausted(payload: Item, reason: string): Promise<void> {
    this.exhausted.push({ payload, reason });
  }
}

/** A RateGate that just counts acquisitions. */
class CountingRate implements RateGate {
  readonly ratePerMin = 60;
  acquired = 0;
  async acquire(): Promise<void> {
    this.acquired += 1;
  }
}

/** Stand up the shared collaborators. */
function deps(): { deps: StageDeps; blob: MemoryBlobStore; lines: Array<Record<string, unknown>> } {
  const { logger, lines } = createMemoryLogger();
  const blob = new MemoryBlobStore();
  const queue = new MemoryQueue();
  return { deps: { queue, blob, log: logger }, blob, lines };
}

/**
 * A second worker that drains the output queue into an array, so tests can assert
 * exactly what was emitted (not just a count).
 */
function collectFrom(queue: MemoryQueue, name: string): Item[] {
  const collected: Item[] = [];
  void queue.work<Item>(
    name,
    async (m: QueueMessage<Item>) => {
      collected.push(m.payload);
    },
    { concurrency: 1 },
  );
  return collected;
}

test("emit → items land on the output queue", async () => {
  const d = deps();
  const queue = d.deps.queue as MemoryQueue;
  const collected = collectFrom(queue, OUT_Q);

  const stage = new TestStage({
    deps: d.deps,
    outputQueue: OUT_Q,
    outcome: (p) => ({ kind: "emit", items: [p, { ark: `${p.ark}-b` }] }),
  });
  await stage.start();

  await queue.send(IN_Q, { ark: "ark:/1" });
  await queue.idle();

  assert.equal(stage.processed.length, 1, "process ran once");
  assert.deepEqual(
    collected,
    [{ ark: "ark:/1" }, { ark: "ark:/1-b" }],
    "both emitted items landed on the output queue in order",
  );
  const outCounts = await queue.counts(OUT_Q);
  assert.equal(outCounts.completed, 2, "two items completed on the output queue");
});

test("done → no emit, message completes", async () => {
  const d = deps();
  const queue = d.deps.queue as MemoryQueue;
  const collected = collectFrom(queue, OUT_Q);

  const stage = new TestStage({ deps: d.deps, outputQueue: OUT_Q, outcome: { kind: "done" } });
  await stage.start();

  await queue.send(IN_Q, { ark: "ark:/1" });
  await queue.idle();

  assert.equal(stage.processed.length, 1, "process ran once");
  assert.deepEqual(collected, [], "nothing emitted on done");
  const inCounts = await queue.counts(IN_Q);
  assert.equal(inCounts.completed, 1, "input message completed");
  assert.equal(inCounts.failed, 0, "no failure");
});

test("skip → no emit, no throw, completes, and is logged", async () => {
  const d = deps();
  const queue = d.deps.queue as MemoryQueue;
  const collected = collectFrom(queue, OUT_Q);

  const stage = new TestStage({
    deps: d.deps,
    outputQueue: OUT_Q,
    outcome: { kind: "skip", reason: "not-in-lane" },
  });
  await stage.start();

  await queue.send(IN_Q, { ark: "ark:/1" });
  await queue.idle();

  assert.deepEqual(collected, [], "nothing emitted on skip");
  const inCounts = await queue.counts(IN_Q);
  assert.equal(inCounts.completed, 1, "input message completed");
  assert.equal(inCounts.failed, 0, "skip is not a failure");

  const skipLog = d.lines.find((l) => l.event === "stage_skip");
  assert.ok(skipLog, "a stage_skip line was logged");
  assert.equal(skipLog?.reason, "not-in-lane", "skip reason carried into the log");
});

test("fail non-terminal → process runs retry.attempts times, message ends failed", async () => {
  const d = deps();
  const queue = d.deps.queue as MemoryQueue;

  const stage = new TestStage({
    deps: d.deps,
    retryAttempts: 3,
    outcome: { kind: "fail", reason: "transient" }, // non-terminal (terminal undefined)
  });
  await stage.start();

  await queue.send(IN_Q, { ark: "ark:/1" });
  await queue.idle();

  assert.equal(stage.processed.length, 3, "process retried up to retry.attempts (3) times");
  const inCounts = await queue.counts(IN_Q);
  assert.equal(inCounts.failed, 1, "message ends in the failed state after retries exhausted");
  assert.equal(inCounts.completed, 0, "non-terminal fail does not complete");
});

test("fail terminal → process runs once, no retry, message completes (swallowed)", async () => {
  const d = deps();
  const queue = d.deps.queue as MemoryQueue;

  const stage = new TestStage({
    deps: d.deps,
    retryAttempts: 3,
    outcome: { kind: "fail", reason: "permanent", terminal: true },
  });
  await stage.start();

  await queue.send(IN_Q, { ark: "ark:/1" });
  await queue.idle();

  assert.equal(stage.processed.length, 1, "terminal fail is not retried — process ran once");
  const inCounts = await queue.counts(IN_Q);
  assert.equal(inCounts.completed, 1, "terminal fail is swallowed → message completes");
  assert.equal(inCounts.failed, 0, "terminal fail does not surface as a queue failure");

  const failLog = d.lines.find((l) => l.event === "stage_fail" && l.terminal === true);
  assert.ok(failLog, "terminal stage_fail logged");
});

test("process that throws is coerced to a non-terminal fail (→ retried)", async () => {
  const d = deps();
  const queue = d.deps.queue as MemoryQueue;

  const stage = new TestStage({
    deps: d.deps,
    retryAttempts: 2,
    outcome: () => {
      throw new Error("boom");
    },
  });
  await stage.start();

  await queue.send(IN_Q, { ark: "ark:/1" });
  await queue.idle();

  assert.equal(stage.processed.length, 2, "thrown error coerced to non-terminal fail → retried");
  const inCounts = await queue.counts(IN_Q);
  assert.equal(inCounts.failed, 1, "exhausted retries end failed");

  const failLog = d.lines.find((l) => l.event === "stage_fail");
  assert.ok(failLog, "a stage_fail was logged for the coerced failure");
  assert.match(String(failLog?.reason), /boom/, "the thrown message is the fail reason");
});

test("onExhausted fires once on the final failed attempt (run-completion safety net)", async () => {
  const d = deps();
  const queue = d.deps.queue as MemoryQueue;

  const stage = new TestStage({
    deps: d.deps,
    retryAttempts: 3,
    outcome: { kind: "fail", reason: "transient" }, // non-terminal, every attempt
  });
  await stage.start();
  await queue.send(IN_Q, { ark: "ark:/strand" });
  await queue.idle();

  assert.equal(stage.processed.length, 3, "retried up to retry.attempts");
  assert.equal(stage.exhausted.length, 1, "onExhausted called exactly once — on the last attempt");
  assert.equal(stage.exhausted[0]?.payload.ark, "ark:/strand");
  assert.match(String(stage.exhausted[0]?.reason), /transient/);
  assert.ok(
    d.lines.find((l) => l.event === "stage_exhausted"),
    "a stage_exhausted warning is logged",
  );
});

test("onExhausted does NOT fire when an attempt eventually succeeds", async () => {
  const d = deps();
  const queue = d.deps.queue as MemoryQueue;

  let n = 0;
  const stage = new TestStage({
    deps: d.deps,
    retryAttempts: 3,
    outcome: () => (++n < 2 ? { kind: "fail", reason: "blip" } : { kind: "done" }),
  });
  await stage.start();
  await queue.send(IN_Q, { ark: "ark:/ok" });
  await queue.idle();

  assert.equal(stage.exhausted.length, 0, "a recovered item never strands");
});

test("resume / idempotency: cache hit skips process() yet re-dispatches the cached emit", async () => {
  const d = deps();
  const queue = d.deps.queue as MemoryQueue;
  const blob = d.blob;
  const collected = collectFrom(queue, OUT_Q);

  const stage = new TestStage({
    deps: d.deps,
    outputQueue: OUT_Q,
    artifactKey: () => "fixed-key",
    outcome: (p) => ({ kind: "emit", items: [p] }),
  });
  await stage.start();

  // First delivery: process runs, outcome persisted, emit appears.
  await queue.send(IN_Q, { ark: "ark:/1" });
  await queue.idle();

  assert.equal(stage.processed.length, 1, "first delivery ran process()");
  assert.equal(await blob.has("fixed-key"), true, "outcome persisted to blob");
  assert.deepEqual(collected, [{ ark: "ark:/1" }], "first delivery emitted");

  // Second delivery with the SAME artifact key: cache hit.
  await queue.send(IN_Q, { ark: "ark:/1" });
  await queue.idle();

  assert.equal(stage.processed.length, 1, "process() was NOT called again on the cache hit");
  assert.deepEqual(
    collected,
    [{ ark: "ark:/1" }, { ark: "ark:/1" }],
    "cached outcome was still re-dispatched — emit re-appeared on the output queue",
  );

  const hitLog = d.lines.find((l) => l.event === "stage_cache_hit");
  assert.ok(hitLog, "cache hit logged");
  assert.equal(hitLog?.key, "fixed-key", "logged the artifact key");
});

test("rate gate is acquired once per processed item, never on a cache hit", async () => {
  const d = deps();
  const queue = d.deps.queue as MemoryQueue;
  const rate = new CountingRate();

  // The stage emits to OUT_Q; attach a consumer so emitted messages drain.
  // (MemoryQueue.idle() scans every queue, so an un-consumed emit would hang it.)
  collectFrom(queue, OUT_Q);

  const stage = new TestStage({
    deps: d.deps,
    outputQueue: OUT_Q,
    rate,
    artifactKey: () => "rate-key",
    outcome: (p) => ({ kind: "emit", items: [p] }),
  });
  await stage.start();

  // First delivery: rate acquired, process runs.
  await queue.send(IN_Q, { ark: "ark:/1" });
  await queue.idle();
  assert.equal(rate.acquired, 1, "rate acquired once for the processed item");
  assert.equal(stage.processed.length, 1);

  // Second delivery: cache hit short-circuits before the rate gate.
  await queue.send(IN_Q, { ark: "ark:/1" });
  await queue.idle();
  assert.equal(rate.acquired, 1, "rate NOT acquired on the cache hit");
  assert.equal(stage.processed.length, 1, "process still not re-run");
});
