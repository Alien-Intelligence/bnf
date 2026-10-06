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
import { Pool, type PoolConfig } from "pg";

import { assertAttemptsSpent, spentFromRetryLimit } from "./queue-attempts.js";
import type { QueueClient, QueueCounts, QueueMessage, QueuePolicyOpts, SendOpts } from "./types.js";

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

/** The policy a caller declares, with the transport's chosen defaults filled in. */
function toPolicy(opts: QueuePolicyOpts): QueuePolicy {
  return {
    retryLimit: opts.retryLimit ?? 3,
    retryDelaySec: Math.max(1, Math.round((opts.retryDelayMs ?? 5_000) / 1000)),
    retryBackoff: opts.retryBackoff ?? true,
    // 600s, not pg-boss's silent 15-min default: a caller that doesn't declare
    // a ceiling still gets a chosen one (see PipelineStage.expireInSeconds).
    expireInSeconds: opts.expireInSeconds ?? 600,
  };
}

/** Postgres codes of a create that lost a race to another creator — the queue exists. */
const ALREADY_EXISTS_CODES = new Set(["23505", "42P07"]);

function isAlreadyExists(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof err.code === "string" &&
    ALREADY_EXISTS_CODES.has(err.code)
  );
}

export class PgBossQueue implements QueueClient {
  private boss: PgBoss | null = null;
  private pool: Pool | null = null;
  private readonly policies = new Map<string, QueuePolicy>();
  private readonly created = new Set<string>();
  /** The policy last written to each queue's row (identity of the `policies` entry). */
  private readonly applied = new Map<string, QueuePolicy>();
  /** Set on stop() so the sliding-window pumps stop fetching new work. */
  private stopped = false;
  /** The per-queue safety-poll timers, cleared on stop(). */
  private readonly workTimers: NodeJS.Timeout[] = [];
  /** Handlers currently running across ALL queues — what stop() drains on. */
  private inFlight = 0;

  /** pg-boss's own pool — built from the caller's config, so it carries both timeouts. */
  private bossPool: Pool | null = null;

  /**
   * `poolConfig` (config.ts pgPoolConfig) is used for BOTH pools — pg-boss's
   * (through its `db` adapter: its own options cannot carry
   * connectionTimeoutMillis) and the read-model one — so neither a job send
   * nor a count can wait forever for a client or a statement.
   */
  constructor(private readonly poolConfig: PoolConfig) {}

  async start(): Promise<void> {
    if (this.boss) return;
    const bossPool = new Pool(this.poolConfig);
    this.bossPool = bossPool;
    const boss = new PgBoss({
      db: { executeSql: (text: string, values: unknown[]) => bossPool.query(text, values) },
    });
    boss.on("error", (err: Error) => console.error("[pg-boss] error:", err.message));
    await boss.start();
    this.boss = boss;
    // Read-model pool (counts / countsForDocs / liveDocJobIds) — separate from
    // pg-boss's own. `statement_timeout` because pg has NO query timeout by
    // default: a lock wait or a bad plan would park the caller forever, and one
    // of those callers is now the reconciliation sweep (CLAUDE_ERROR_PATTERNS
    // §14 — every external await bounded). 30s is ~100× the measured cost of
    // these queries, so it only ever fires on something genuinely stuck.
    this.pool = new Pool(this.poolConfig);
  }

  private b(): PgBoss {
    if (!this.boss) throw new Error("PgBossQueue not started");
    return this.boss;
  }

  /**
   * Complete or fail a delivery. After stop() (pg-boss closed) there is
   * nothing to talk to: the job is deliberately left `active` and expires —
   * logged, never a throw out of a finished handler.
   */
  private async settle(
    queue: string,
    jobId: string,
    outcome: { kind: "complete" } | { kind: "fail"; error: string },
  ): Promise<void> {
    const boss = this.boss;
    if (boss === null) {
      console.error(
        `[pg-boss] ${queue}/${jobId} finished after stop(): left active, pg-boss expires it`,
      );
      return;
    }
    const call =
      outcome.kind === "complete" ? boss.complete(queue, jobId) : boss.fail(queue, jobId, { error: outcome.error });
    await call.catch((e: unknown) => console.error(`[pg-boss] ${outcome.kind}() failed:`, e));
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
   *
   * The early return is for a queue whose CURRENT policy is already written:
   * a `send` before the consuming stage's `work()` (a producer stage that
   * starts first) creates the row without a policy, and the later `work()`
   * must still write it — `applied` tracks which policy the row has.
   */
  private async ensureQueue(name: string): Promise<QueuePolicy> {
    const p = this.policies.get(name);
    if (!p) {
      // A job sent with pg-boss's defaults would carry the silent 15-min
      // expiry and retry_limit 2 (pass-6 item 9): every queue is declared by
      // its consuming stage (Pipeline.start) before anything is sent.
      throw new Error(`PgBossQueue: queue ${name} has no declared policy (declare() it before sending or working)`);
    }
    if (this.created.has(name) && this.applied.get(name) === p) return p;
    const queueOpts = {
      name,
      retryLimit: p.retryLimit,
      retryDelay: p.retryDelaySec,
      retryBackoff: p.retryBackoff,
      expireInSeconds: p.expireInSeconds,
    };
    if (!this.created.has(name)) {
      // create_queue is ON CONFLICT DO NOTHING; only a create that loses a
      // race to another creator can still say "exists". Anything else throws.
      await this.b()
        .createQueue(name, queueOpts)
        .catch((e: unknown) => {
          if (!isAlreadyExists(e)) throw e;
        });
      this.created.add(name);
    }
    // A failed policy write throws: the queue is not recorded as applied, so
    // the next send or work() writes it again.
    await this.b().updateQueue(name, queueOpts);
    this.applied.set(name, p);
    return p;
  }

  declare(queue: string, policy: QueuePolicyOpts): void {
    const next = toPolicy(policy);
    const current = this.policies.get(queue);
    const same =
      current !== undefined &&
      current.retryLimit === next.retryLimit &&
      current.retryDelaySec === next.retryDelaySec &&
      current.retryBackoff === next.retryBackoff &&
      current.expireInSeconds === next.expireInSeconds;
    if (!same) this.policies.set(queue, next);
  }

  /** The job-level options every job of `queue` carries (they override the queue row). */
  private jobOpts(p: QueuePolicy, spent: number): Record<string, unknown> {
    return {
      // A hand-back's copy: only what is left of the budget (the attempts
      // are recovered from it, runJob).
      retryLimit: Math.max(0, p.retryLimit - spent),
      retryDelay: p.retryDelaySec,
      retryBackoff: p.retryBackoff,
      expireInSeconds: p.expireInSeconds,
    };
  }

  async send<T>(queue: string, payload: T, opts?: SendOpts): Promise<void> {
    const spent = opts?.attemptsSpent ?? 0;
    assertAttemptsSpent(spent);
    const p = await this.ensureQueue(queue);
    const sendOpts = this.jobOpts(p, spent);
    // Defer delivery (e.g. the OCR poll re-enqueue) — pg-boss takes whole seconds.
    if (opts?.startAfterMs && opts.startAfterMs > 0) {
      sendOpts.startAfter = Math.max(1, Math.round(opts.startAfterMs / 1000));
    }
    await this.b().send(queue, payload as object, sendOpts);
  }

  async sendMany<T>(queue: string, payloads: readonly T[]): Promise<void> {
    const p = await this.ensureQueue(queue);
    const opts = this.jobOpts(p, 0);
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
    opts: QueuePolicyOpts & { concurrency: number },
  ): Promise<void> {
    this.declare(queue, opts);
    const policy = await this.ensureQueue(queue);

    const cap = Math.max(1, Math.floor(opts.concurrency));
    let inFlight = 0; // this queue's slots (the pump's own accounting)
    let pumping = false; // guards against overlapping fetch loops

    const runJob = (job: PgBoss.JobWithMetadata<T>): void => {
      inFlight++;
      this.inFlight++; // process-wide, so stop() can drain across all queues
      void (async () => {
        try {
          // A hand-back's copy was sent with a reduced retry_limit: the
          // deliveries its predecessors spent are the difference.
          const spent = spentFromRetryLimit(policy.retryLimit, job.retryLimit);
          const attempts = spent + (job.retryCount ?? 0) + 1;
          await handler({ id: job.id, payload: job.data, attempts });
          await this.settle(queue, job.id, { kind: "complete" });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          await this.settle(queue, job.id, { kind: "fail", error });
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
   * Shutdown phase 1 (QueueClient.drain): stop fetching and wait for the
   * in-flight handlers, up to `budgetMs`, with pg-boss ALIVE — so a handler
   * can still complete, fail, or hand its delivery back (`send`).
   *
   * The drain has to be OURS (F12): pg-boss's graceful stop waits on the work-in-
   * progress of its own `work()` workers, and we consume via `fetch()`.
   */
  async drain(budgetMs: number): Promise<number> {
    this.stopped = true;
    for (const t of this.workTimers) clearInterval(t);
    this.workTimers.length = 0;
    const deadline = Date.now() + budgetMs;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.inFlight;
  }

  /**
   * Shutdown phase 2: drain anything left (if drain() was not called), then
   * shut pg-boss down and end both pools. A handler still running after this
   * leaves its job `active` for pg-boss to expire (settle()).
   */
  async stop(): Promise<void> {
    if (!this.stopped) await this.drain(GRACEFUL_STOP_TIMEOUT_MS);
    if (this.inFlight > 0) {
      console.error(
        `[pg-boss] stopping with ${this.inFlight} handler(s) still in flight` +
          " — their jobs stay `active` until pg-boss expires them",
      );
    }
    await this.boss
      ?.stop({ graceful: true, timeout: 1_000 })
      .catch((e: unknown) => console.error("[pg-boss] stop() failed:", e));
    await this.pool?.end().catch(() => undefined);
    await this.bossPool?.end().catch(() => undefined);
    this.boss = null;
    this.pool = null;
    this.bossPool = null;
  }
}
