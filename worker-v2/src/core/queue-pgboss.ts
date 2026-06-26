/**
 * pg-boss-backed queue — the production bucket transport. Implements the same
 * `QueueClient` contract as MemoryQueue, so stages/tests are identical against
 * either. Mirrors V1's proven pg-boss v10 usage:
 *  - `createQueue(name, policy)` is idempotent; each queue carries its stage's
 *    retry policy (retryLimit/retryDelay/retryBackoff).
 *  - `work(name, {batchSize}, handler)` gets a BATCH of jobs; we Promise.all over
 *    them and `boss.fail(name, job.id)` per-job on throw, so one bad job doesn't
 *    fail the whole batch and pg-boss's retry fires per job.
 *  - `counts()` reads the `pgboss.job` table by state for the progress read-model.
 */
import PgBoss from "pg-boss";
import { Pool } from "pg";

import type { QueueClient, QueueCounts, QueueMessage } from "./types.js";

interface QueuePolicy {
  retryLimit: number;
  retryDelaySec: number;
  retryBackoff: boolean;
}

export class PgBossQueue implements QueueClient {
  private boss: PgBoss | null = null;
  private pool: Pool | null = null;
  private readonly policies = new Map<string, QueuePolicy>();
  private readonly created = new Set<string>();

  constructor(private readonly connectionString: string) {}

  async start(): Promise<void> {
    if (this.boss) return;
    const boss = new PgBoss({ connectionString: this.connectionString });
    boss.on("error", (err: Error) => console.error("[pg-boss] error:", err.message));
    await boss.start();
    this.boss = boss;
    this.pool = new Pool({ connectionString: this.connectionString });
  }

  private b(): PgBoss {
    if (!this.boss) throw new Error("PgBossQueue not started");
    return this.boss;
  }

  private async ensureQueue(name: string, policy?: QueuePolicy): Promise<void> {
    if (policy) this.policies.set(name, policy);
    if (this.created.has(name)) return;
    const p = this.policies.get(name);
    await this.b()
      .createQueue(
        name,
        p
          ? { name, retryLimit: p.retryLimit, retryDelay: p.retryDelaySec, retryBackoff: p.retryBackoff }
          : { name },
      )
      .catch(() => undefined); // idempotent
    this.created.add(name);
  }

  async send<T>(queue: string, payload: T, opts?: { startAfterMs?: number }): Promise<void> {
    await this.ensureQueue(queue);
    const p = this.policies.get(queue);
    const sendOpts: Record<string, unknown> = p
      ? { retryLimit: p.retryLimit, retryDelay: p.retryDelaySec, retryBackoff: p.retryBackoff }
      : {};
    // Defer delivery (e.g. the OCR poll re-enqueue) — pg-boss takes whole seconds.
    if (opts?.startAfterMs && opts.startAfterMs > 0) {
      sendOpts.startAfter = Math.max(1, Math.round(opts.startAfterMs / 1000));
    }
    await this.b().send(queue, payload as object, sendOpts);
  }

  async sendMany<T>(queue: string, payloads: readonly T[]): Promise<void> {
    await this.ensureQueue(queue);
    const p = this.policies.get(queue);
    const opts = p
      ? { retryLimit: p.retryLimit, retryDelay: p.retryDelaySec, retryBackoff: p.retryBackoff }
      : {};
    await this.b().insert(
      payloads.map((data) => ({ name: queue, data: data as object, ...opts })),
    );
  }

  async work<T>(
    queue: string,
    handler: (msg: QueueMessage<T>) => Promise<void>,
    opts: { concurrency: number; retryLimit?: number; retryDelayMs?: number; retryBackoff?: boolean },
  ): Promise<void> {
    await this.ensureQueue(queue, {
      retryLimit: opts.retryLimit ?? 3,
      retryDelaySec: Math.max(1, Math.round((opts.retryDelayMs ?? 5_000) / 1000)),
      retryBackoff: opts.retryBackoff ?? true,
    });
    await this.b().work<T>(
      queue,
      { batchSize: opts.concurrency, pollingIntervalSeconds: 1, includeMetadata: true },
      async (jobs) => {
        await Promise.all(
          jobs.map(async (job) => {
            const attempts = ((job as { retryCount?: number }).retryCount ?? 0) + 1;
            try {
              await handler({ id: job.id, payload: job.data as T, attempts });
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              await this.b()
                .fail(queue, job.id, { error })
                .catch((e) => console.error("[pg-boss] fail() failed:", e));
            }
          }),
        );
      },
    );
  }

  async counts(queue: string): Promise<QueueCounts> {
    const pool = this.pool;
    if (!pool) throw new Error("PgBossQueue not started");
    const { rows } = await pool.query<{ state: string; n: string }>(
      `SELECT state, count(*)::text n FROM pgboss.job WHERE name = $1 GROUP BY state`,
      [queue],
    );
    const by = new Map(rows.map((r) => [r.state, Number(r.n)]));
    return {
      queued: (by.get("created") ?? 0) + (by.get("retry") ?? 0),
      running: by.get("active") ?? 0,
      completed: by.get("completed") ?? 0,
      failed: by.get("failed") ?? 0,
    };
  }

  async stop(): Promise<void> {
    await this.boss?.stop({ graceful: true }).catch(() => undefined);
    await this.pool?.end().catch(() => undefined);
    this.boss = null;
    this.pool = null;
  }
}
