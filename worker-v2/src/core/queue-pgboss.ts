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
  /**
   * pg-boss's per-delivery wall-clock ceiling. Undefined would mean pg-boss's
   * SILENT 15-minute default — the thing that wedged prod run efe5d747 (F7/F10,
   * see PipelineStage.expireInSeconds), so every stage declares it.
   */
  expireInSeconds: number;
}

/**
 * How long `stop()` waits for in-flight handlers before pg-boss stops waiting.
 * The pod's terminationGracePeriodSeconds is 120s, and pg-boss's own default
 * graceful wait is 30s — far under a 135s BnF fetch, so a deploy used to kill
 * in-flight deliveries that (pre-Slice-3) could orphan their doc (F12). 110s
 * leaves ~10s for the rest of shutdown inside the pod's grace window.
 */
const GRACEFUL_STOP_TIMEOUT_MS = 110_000;

export class PgBossQueue implements QueueClient {
  private boss: PgBoss | null = null;
  private pool: Pool | null = null;
  private readonly policies = new Map<string, QueuePolicy>();
  private readonly created = new Set<string>();
  /** Set on stop() so the sliding-window pumps stop fetching new work. */
  private stopped = false;
  /** The per-queue safety-poll timers, cleared on stop(). */
  private readonly workTimers: NodeJS.Timeout[] = [];
  /** Handlers currently running across ALL queues — what stop() drains on. */
  private inFlight = 0;

  constructor(private readonly connectionString: string) {}

  async start(): Promise<void> {
    if (this.boss) return;
    const boss = new PgBoss({ connectionString: this.connectionString });
    boss.on("error", (err: Error) => console.error("[pg-boss] error:", err.message));
    await boss.start();
    this.boss = boss;
    // Read-model pool (counts / countsForDocs / liveDocJobIds) — separate from
    // pg-boss's own. `statement_timeout` because pg has NO query timeout by
    // default: a lock wait or a bad plan would park the caller forever, and one
    // of those callers is now the reconciliation sweep (CLAUDE_ERROR_PATTERNS
    // §14 — every external await bounded). 30s is ~100× the measured cost of
    // these queries, so it only ever fires on something genuinely stuck.
    this.pool = new Pool({ connectionString: this.connectionString, statement_timeout: 30_000 });
  }

  private b(): PgBoss {
    if (!this.boss) throw new Error("PgBossQueue not started");
    return this.boss;
  }

  /**
   * Create the queue if absent, then UPDATE its policy if it already existed.
   *
   * The update is not redundant: `create_queue` is `ON CONFLICT DO NOTHING`, so on
   * an existing queue — which is every queue in a deployed environment — a new
   * policy would be silently ignored. That is why prod queues still carried
   * `expire_seconds = NULL` (pg-boss's 15-min default) long after the stages
   * "declared" their retry policy: nothing ever wrote the row again. `updateQueue`
   * COALESCEs each column, so it applies the declared values without clobbering
   * anything we don't set.
   */
  private async ensureQueue(name: string, policy?: QueuePolicy): Promise<void> {
    if (policy) this.policies.set(name, policy);
    if (this.created.has(name)) return;
    const p = this.policies.get(name);
    const queueOpts = p
      ? {
          name,
          retryLimit: p.retryLimit,
          retryDelay: p.retryDelaySec,
          retryBackoff: p.retryBackoff,
          expireInSeconds: p.expireInSeconds,
        }
      : { name };
    await this.b()
      .createQueue(name, queueOpts)
      .catch(() => undefined); // idempotent
    if (p) {
      await this.b()
        .updateQueue(name, queueOpts)
        .catch((e) => console.error(`[pg-boss] updateQueue(${name}) failed:`, e));
    }
    this.created.add(name);
  }

  async send<T>(queue: string, payload: T, opts?: { startAfterMs?: number }): Promise<void> {
    await this.ensureQueue(queue);
    const p = this.policies.get(queue);
    // Job-level options override the queue row, so a job inserted before/while
    // the queue policy is being applied still carries the right ceiling.
    const sendOpts: Record<string, unknown> = p
      ? {
          retryLimit: p.retryLimit,
          retryDelay: p.retryDelaySec,
          retryBackoff: p.retryBackoff,
          expireInSeconds: p.expireInSeconds,
        }
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
      ? {
          retryLimit: p.retryLimit,
          retryDelay: p.retryDelaySec,
          retryBackoff: p.retryBackoff,
          expireInSeconds: p.expireInSeconds,
        }
      : {};
    await this.b().insert(
      payloads.map((data) => ({ name: queue, data: data as object, ...opts })),
    );
  }

  /**
   * Consume `queue` with a SLIDING-WINDOW worker pool of up to `concurrency`
   * in-flight jobs — NOT pg-boss's batch handler.
   *
   * The batch handler (`boss.work({batchSize})`) is a BARRIER: it fetches a batch,
   * marks them all `active`, and does not fetch the next batch until the handler
   * resolves for the WHOLE batch (a `Promise.all`). So a batch drains at the speed
   * of its slowest member; during the tail, slots sit idle and no new work is
   * pulled — and a single straggler (a slow BnF fetch, worse with the 135s timeout)
   * freezes every other slot. Measured effect: the fetch stage held ~128 jobs in
   * `active` (the whole checked-out batch) while only ~20 were truly in flight at
   * BnF, capping throughput at ~600/min against a 1000/min quota.
   *
   * Instead we `fetch` exactly the free capacity, start each job independently, and
   * `complete`/`fail` it the instant it finishes — refilling that one slot at once.
   * A straggler holds only its own slot; the rate gate stays continuously fed; the
   * `active` count becomes the TRUE in-flight number, not a checked-out batch.
   */
  async work<T>(
    queue: string,
    handler: (msg: QueueMessage<T>) => Promise<void>,
    opts: {
      concurrency: number;
      retryLimit?: number;
      retryDelayMs?: number;
      retryBackoff?: boolean;
      expireInSeconds?: number;
    },
  ): Promise<void> {
    await this.ensureQueue(queue, {
      retryLimit: opts.retryLimit ?? 3,
      retryDelaySec: Math.max(1, Math.round((opts.retryDelayMs ?? 5_000) / 1000)),
      retryBackoff: opts.retryBackoff ?? true,
      // 600s, not pg-boss's silent 15-min default: a caller that doesn't declare
      // a ceiling still gets a chosen one (see PipelineStage.expireInSeconds).
      expireInSeconds: opts.expireInSeconds ?? 600,
    });

    const cap = Math.max(1, Math.floor(opts.concurrency));
    let inFlight = 0; // this queue's slots (the pump's own accounting)
    let pumping = false; // guards against overlapping fetch loops

    const runJob = (job: PgBoss.JobWithMetadata<T>): void => {
      inFlight++;
      this.inFlight++; // process-wide, so stop() can drain across all queues
      void (async () => {
        const attempts = (job.retryCount ?? 0) + 1;
        try {
          await handler({ id: job.id, payload: job.data, attempts });
          await this.b()
            .complete(queue, job.id)
            .catch((e) => console.error("[pg-boss] complete() failed:", e));
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          await this.b()
            .fail(queue, job.id, { error })
            .catch((e) => console.error("[pg-boss] fail() failed:", e));
        } finally {
          inFlight--;
          this.inFlight--;
          void pump(); // a slot freed → refill immediately
        }
      })();
    };

    const pump = async (): Promise<void> => {
      if (this.stopped || pumping) return;
      pumping = true;
      try {
        while (!this.stopped) {
          const free = cap - inFlight;
          if (free <= 0) break; // pool full → completions will re-pump
          const jobs = await this.b().fetch<T>(queue, {
            batchSize: free,
            includeMetadata: true,
          });
          if (!jobs || jobs.length === 0) break; // queue drained → the poll timer retries
          for (const job of jobs) runJob(job);
          if (jobs.length < free) break; // fewer than asked → nothing left to pull now
        }
      } catch (e) {
        console.error(`[pg-boss] fetch() failed for ${queue}:`, e);
      } finally {
        pumping = false;
      }
    };

    // Safety poll: catches jobs that arrive while the pool is idle (the
    // completion-driven re-pump only fires while jobs are draining).
    const timer = setInterval(() => void pump(), 1_000);
    this.workTimers.push(timer);
    void pump();
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

  async countsForDocs(queue: string, docJobIds: readonly string[]): Promise<QueueCounts> {
    const pool = this.pool;
    if (!pool) throw new Error("PgBossQueue not started");
    if (docJobIds.length === 0) return { queued: 0, running: 0, completed: 0, failed: 0 };
    // Only the IN-FLIGHT states (active/created/retry) — these are what the card
    // shows per stage, and pg-boss's (name,state) index keeps this cheap even when
    // the queue holds tens of thousands of COMPLETED jobs (which we never scan).
    // completed/failed come from the run-scoped doc-state, not from here.
    const { rows } = await pool.query<{ state: string; n: string }>(
      `SELECT state, count(*)::text n FROM pgboss.job
        WHERE name = $1 AND state IN ('active','created','retry')
          AND data->>'docJobId' = ANY($2)
        GROUP BY state`,
      [queue, docJobIds as string[]],
    );
    const by = new Map(rows.map((r) => [r.state, Number(r.n)]));
    return {
      queued: (by.get("created") ?? 0) + (by.get("retry") ?? 0),
      running: by.get("active") ?? 0,
      completed: 0,
      failed: 0,
    };
  }

  /**
   * ONE query per sweep: the live (`created`/`active`/`retry`) jobs across the
   * given queues whose payload carries one of the given docJobIds. `name = ANY`
   * prunes to those queues' partitions (pg-boss list-partitions `pgboss.job` by
   * queue name) and the state filter keeps it off the completed/failed mass —
   * the same shape countsForDocs already runs in prod, widened to N queues.
   */
  async liveDocJobIds(
    queues: readonly string[],
    docJobIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const pool = this.pool;
    if (!pool) throw new Error("PgBossQueue not started");
    if (queues.length === 0 || docJobIds.length === 0) return new Set<string>();
    const { rows } = await pool.query<{ doc_job_id: string }>(
      `SELECT DISTINCT data->>'docJobId' AS doc_job_id FROM pgboss.job
        WHERE name = ANY($1) AND state IN ('active','created','retry')
          AND data->>'docJobId' = ANY($2)`,
      [queues as string[], docJobIds as string[]],
    );
    return new Set(rows.map((r) => r.doc_job_id));
  }

  /**
   * Stop fetching, drain what is already running, then shut pg-boss down.
   *
   * The drain has to be OURS (F12): pg-boss's graceful stop waits on the work-in-
   * progress of its own `work()` workers, and we consume via `fetch()` — so
   * `boss.stop()` sees zero WIP, returns instantly, closes its pool, and every
   * still-running handler's `complete()`/`fail()` then fails. With a 135s BnF fetch
   * inside a 120s terminationGracePeriodSeconds that meant a deploy routinely
   * killed in-flight deliveries mid-call. Now we wait for the real in-flight count,
   * bounded by ONE budget shared with pg-boss's own wait (CLAUDE_ERROR_PATTERNS
   * §14 — the wait is bounded, and it exits the instant nothing is in flight).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.workTimers) clearInterval(t);
    this.workTimers.length = 0;

    const deadline = Date.now() + GRACEFUL_STOP_TIMEOUT_MS;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.inFlight > 0) {
      console.error(
        `[pg-boss] graceful stop budget exhausted with ${this.inFlight} handler(s) in flight` +
          " — their jobs stay `active` until pg-boss expires them (the reconciliation" +
          " sweep re-drives the affected docs on the next boot)",
      );
    }

    await this.boss
      ?.stop({ graceful: true, timeout: Math.max(1_000, deadline - Date.now()) })
      .catch(() => undefined);
    await this.pool?.end().catch(() => undefined);
    this.boss = null;
    this.pool = null;
  }
}
