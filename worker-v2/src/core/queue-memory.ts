/**
 * In-memory queue — the unit-test workhorse. Models at-least-once delivery with
 * bounded concurrency and retry-on-throw (up to retryLimit), so the stage base
 * can be tested end-to-end without Postgres. Retry backoff is collapsed to
 * immediate re-delivery (tests assert attempts/outcomes, not wall-clock timing).
 */
import type { QueueClient, QueueCounts, QueueMessage } from "./types.js";

interface MemMsg {
  id: string;
  payload: unknown;
  attempts: number; // deliveries so far
  state: "queued" | "active" | "completed" | "failed";
}

interface Worker {
  handler: (msg: QueueMessage<unknown>) => Promise<void>;
  concurrency: number;
  retryLimit: number;
  active: number;
}

export class MemoryQueue implements QueueClient {
  private readonly queues = new Map<string, MemMsg[]>();
  private readonly workers = new Map<string, Worker>();
  private seq = 0;
  private readonly idleResolvers: Array<() => void> = [];

  private q(name: string): MemMsg[] {
    let arr = this.queues.get(name);
    if (!arr) {
      arr = [];
      this.queues.set(name, arr);
    }
    return arr;
  }

  async send<T>(queue: string, payload: T, _opts?: { startAfterMs?: number }): Promise<void> {
    // startAfterMs is a prod (pg-boss) concern; the test queue delivers immediately.
    this.q(queue).push({ id: `m${++this.seq}`, payload, attempts: 0, state: "queued" });
    queueMicrotask(() => this.pump(queue));
  }

  async sendMany<T>(queue: string, payloads: readonly T[]): Promise<void> {
    for (const p of payloads) {
      this.q(queue).push({ id: `m${++this.seq}`, payload: p, attempts: 0, state: "queued" });
    }
    queueMicrotask(() => this.pump(queue));
  }

  async work<T>(
    queue: string,
    handler: (msg: QueueMessage<T>) => Promise<void>,
    opts: { concurrency: number; retryLimit?: number },
  ): Promise<void> {
    this.workers.set(queue, {
      handler: handler as Worker["handler"],
      concurrency: opts.concurrency,
      retryLimit: opts.retryLimit ?? 0,
      active: 0,
    });
    queueMicrotask(() => this.pump(queue));
  }

  private pump(queue: string): void {
    const w = this.workers.get(queue);
    const arr = this.queues.get(queue);
    if (!w || !arr) return;
    while (w.active < w.concurrency) {
      const msg = arr.find((m) => m.state === "queued");
      if (!msg) break;
      msg.state = "active";
      msg.attempts += 1;
      w.active += 1;
      void this.run(queue, w, msg);
    }
  }

  private async run(queue: string, w: Worker, msg: MemMsg): Promise<void> {
    try {
      await w.handler({ id: msg.id, payload: msg.payload, attempts: msg.attempts });
      msg.state = "completed";
    } catch {
      // at-least-once: redeliver until retryLimit exhausted, then fail terminally.
      if (msg.attempts <= w.retryLimit) {
        msg.state = "queued";
      } else {
        msg.state = "failed";
      }
    } finally {
      w.active -= 1;
      queueMicrotask(() => {
        this.pump(queue);
        this.maybeIdle();
      });
    }
  }

  private maybeIdle(): void {
    if (this.idleResolvers.length === 0) return;
    const busy = [...this.queues.values()].some((arr) =>
      arr.some((m) => m.state === "queued" || m.state === "active"),
    );
    const working = [...this.workers.values()].some((w) => w.active > 0);
    if (!busy && !working) {
      while (this.idleResolvers.length) this.idleResolvers.shift()?.();
    }
  }

  /** Resolve when every worked queue is drained (no queued/active items). Test helper. */
  idle(): Promise<void> {
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
      this.maybeIdle();
    });
  }

  async counts(queue: string): Promise<QueueCounts> {
    const arr = this.queues.get(queue) ?? [];
    return {
      queued: arr.filter((m) => m.state === "queued").length,
      running: arr.filter((m) => m.state === "active").length,
      completed: arr.filter((m) => m.state === "completed").length,
      failed: arr.filter((m) => m.state === "failed").length,
    };
  }

  async stop(): Promise<void> {
    this.workers.clear();
  }
}
