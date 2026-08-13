/**
 * PipelineStage — the reusable base every concrete stage extends. Owns the
 * identical-for-every-stage lifecycle so a stage only implements `process()`:
 *
 *   consume from inputQueue
 *     → [resume] if this stage's outcome is already cached in S3, skip process()
 *       and re-dispatch the cached outcome (idempotent; resumes mid-pipeline)
 *     → acquire a rate token (if the stage is rate-capped)
 *     → process(payload)  ← the ONLY thing subclasses write
 *     → persist the outcome to S3 (so a future replay skips this stage)
 *     → dispatch: emit pointer(s) to outputQueue | done | skip | fail(retry|terminal)
 *
 * Retry/terminal: a non-terminal `fail` throws → the queue redelivers (backoff up
 * to retry.attempts). A terminal `fail` is swallowed → the queue completes the
 * message (no retry). Success persists the outcome → the work never repeats.
 */
import type {
  BlobStore,
  Logger,
  QueueClient,
  QueueMessage,
  RateGate,
  RetryPolicy,
  StageContext,
  StageOutcome,
} from "./types.js";

/**
 * The generic per-delivery ceiling every stage inherits unless it declares its own
 * (see PipelineStage.expireInSeconds). 10 minutes: above any S3-bound handler,
 * below the point where an expiry would read as a hang.
 */
export const DEFAULT_EXPIRE_IN_SECONDS = 600;

export interface StageDeps {
  queue: QueueClient;
  blob: BlobStore;
  log: Logger;
  /** Optional progress/observability hook, fired once per dispatched outcome. */
  onOutcome?: (e: {
    stage: string;
    kind: StageOutcome<unknown>["kind"];
    payload: unknown;
    fromCache: boolean;
  }) => void;
}

export abstract class PipelineStage<In, Out> {
  abstract readonly name: string;
  abstract readonly inputQueue: string;
  readonly outputQueue?: string;
  readonly concurrency: number = 4;
  readonly rate?: RateGate;
  readonly retry: RetryPolicy = { attempts: 4, baseMs: 500, maxDelayMs: 30_000 };
  /**
   * Override the queue transport's redelivery pacing (pg-boss `retryDelay`,
   * seconds under the hood — see queue-pgboss.ts). Undefined keeps the
   * transport's own default (pg-boss: 5s, retryBackoff true).
   *
   * BnF enforces its manifest quota over FIXED CLOCK-MINUTE windows, not a
   * sliding one — so a retry that lands 5-10s later almost always lands in the
   * SAME still-closed window and gets shed again (F6,
   * ai-memories/tech/repos/bnf/ingest-hardening). Stages that share the
   * manifest gate set this to 30_000: with pg-boss's default retryBackoff
   * (true), that spans 30/60/120s — the second attempt already lands in the
   * NEXT window. This is deliberately just a delay knob, not a smarter
   * per-message re-enqueue scheduler — the queue's own backoff is enough once
   * the base delay respects BnF's window size.
   */
  readonly queueRetryDelayMs?: number;
  /**
   * Wall-clock ceiling (seconds) the TRANSPORT puts on one delivery of this
   * stage's message: past it, pg-boss expires the job from the outside
   * ("job failed by timeout in active state").
   *
   * This MUST be declared, not inherited from the transport, because an expired
   * job runs NO handler code — every last-attempt reconciliation idiom in this
   * codebase (MetadataStage/FetchStage's in-process exhaustion branch,
   * `onExhausted` below) is bypassed, and the doc orphans in a non-terminal
   * status forever. That is exactly how prod run efe5d747 wedged at 464/465: a
   * mid-run redeploy orphaned an in-flight v2.metadata delivery, pg-boss expired
   * it at its SILENT 15-minute default (`expire_seconds` was NULL on every
   * queue), and the doc stayed `queued` forever (F7/F10,
   * ai-memories/tech/repos/bnf/ingest-hardening).
   *
   * So each stage sets this to its own worst-case handler wall-clock + margin.
   * The default below (10 min) is the safe generic: comfortably above any
   * S3-bound handler, comfortably below the point where an expiry would look
   * like a hang. Stages whose worst case is materially different override it.
   * The reconciliation sweep (live/reconciler.ts) is the second belt: whatever
   * the ceiling, an expired job's doc gets re-driven within a sweep interval.
   */
  readonly expireInSeconds: number = DEFAULT_EXPIRE_IN_SECONDS;

  protected readonly queue: QueueClient;
  protected readonly blob: BlobStore;
  protected log: Logger;
  private readonly onOutcome?: StageDeps["onOutcome"];

  constructor(deps: StageDeps) {
    this.queue = deps.queue;
    this.blob = deps.blob;
    this.log = deps.log; // re-bound with the stage name in start()
    this.onOutcome = deps.onOutcome;
  }

  /** The only method a concrete stage must implement. */
  abstract process(payload: In, ctx: StageContext): Promise<StageOutcome<Out>>;

  /**
   * Deterministic S3 key whose presence means "this stage already produced its
   * outcome for this item" → skip + resume. Return null to always run (e.g. the
   * Monitor, whose state lives in the DB not S3).
   */
  artifactKey(_payload: In): string | null {
    return null;
  }

  /**
   * Safety net for run completion: called when process() THROWS on the LAST
   * allowed delivery (retries exhausted). A lane stage that owns a doc overrides
   * this to mark the doc terminally failed — otherwise an unhandled throw (S3
   * blip, a worker restart mid-call, a provider outage) would leave the doc in a
   * non-terminal status forever and the run could never complete. Default no-op
   * (stages whose payload isn't a doc, or that already self-fail, need nothing).
   */
  protected async onExhausted(_payload: In, _reason: string): Promise<void> {}

  async start(): Promise<void> {
    this.log = this.log.child({ stage: this.name });
    await this.queue.work<In>(this.inputQueue, (m) => this.handle(m), {
      concurrency: this.concurrency,
      retryLimit: Math.max(0, this.retry.attempts - 1),
      expireInSeconds: this.expireInSeconds,
      ...(this.queueRetryDelayMs !== undefined
        ? { retryDelayMs: this.queueRetryDelayMs }
        : {}),
    });
    this.log.info("stage_started", {
      queue: this.inputQueue,
      out: this.outputQueue ?? null,
      concurrency: this.concurrency,
      rate: this.rate?.ratePerMin ?? null,
      expireInSeconds: this.expireInSeconds,
    });
  }

  /**
   * One delivery. EVERY external call in here — the artifact-cache read, the rate
   * acquire, process(), the outcome persist, the dispatch send — sits inside the
   * same guarded region, so a throw from ANY of them on the FINAL attempt runs the
   * `onExhausted` safety net before the error reaches the transport.
   *
   * That widening is F11 (ai-memories/tech/repos/bnf/ingest-hardening): the cache
   * read and the outcome persist used to sit OUTSIDE the try, so an S3 blip on the
   * last attempt failed the pg-boss job without marking the doc — the same orphan
   * class as an expired job, reached by a different door. The net fires at most
   * once per delivery (`netFired`), so a non-terminal fail (which reaches the
   * transport by throwing out of dispatch) still triggers it exactly once.
   */
  private async handle(msg: QueueMessage<In>): Promise<void> {
    const ctx: StageContext = {
      blob: this.blob,
      log: this.log.child({ msg: msg.id, attempt: msg.attempts }),
      messageId: msg.id,
      attempt: msg.attempts,
    };
    // The FINAL allowed delivery: no redelivery follows, so anything left
    // non-terminal here stays non-terminal forever unless the net runs.
    const lastAttempt = msg.attempts >= this.retry.attempts;
    let netFired = false;
    const net = async (reason: string): Promise<void> => {
      if (!lastAttempt || netFired) return;
      netFired = true;
      await this.onExhausted(msg.payload, reason).catch((err) =>
        this.log.error("on_exhausted_failed", { error: errMsg(err) }),
      );
      this.log.warn("stage_exhausted", { reason, attempts: msg.attempts });
    };

    try {
      // Resume / idempotency: a cached outcome means this stage already ran.
      const key = this.artifactKey(msg.payload);
      if (key) {
        const cached = await this.blob.getJson<StageOutcome<Out>>(key);
        if (cached) {
          this.log.info("stage_cache_hit", { key });
          await this.dispatch(cached, msg.payload, true);
          return;
        }
      }

      if (this.rate) await this.rate.acquire();

      let outcome: StageOutcome<Out>;
      try {
        outcome = await this.process(msg.payload, ctx);
      } catch (e) {
        outcome = { kind: "fail", reason: describeError(e) };
      }

      // A non-terminal fail on the final attempt means retries are exhausted:
      // the queue will mark the MESSAGE failed, but nothing marks the DOC. Give
      // the stage a chance to mark it (onExhausted). The outcome stays
      // non-terminal so the queue records the message failure exactly as before.
      if (outcome.kind === "fail" && outcome.terminal !== true) {
        await net(outcome.reason);
      }

      if (key && (outcome.kind === "emit" || outcome.kind === "done")) {
        await this.blob.putJson(key, outcome);
      }
      await this.dispatch(outcome, msg.payload, false);
    } catch (e) {
      // Anything that escaped the inner catch: an S3 read/write, a rate gate
      // shutdown, the dispatch send — or dispatch's own re-throw of a
      // non-terminal fail (whose net already fired, hence the once-guard).
      await net(describeError(e));
      throw e;
    }
  }

  private async dispatch(
    outcome: StageOutcome<Out>,
    payload: In,
    fromCache: boolean,
  ): Promise<void> {
    this.onOutcome?.({ stage: this.name, kind: outcome.kind, payload, fromCache });
    switch (outcome.kind) {
      case "emit":
        if (this.outputQueue) {
          await this.queue.sendMany(this.outputQueue, outcome.items);
        } else if (outcome.items.length > 0) {
          this.log.warn("emit_without_output_queue", { count: outcome.items.length });
        }
        return;
      case "done":
        return;
      case "skip":
        this.log.info("stage_skip", { reason: outcome.reason });
        return;
      case "fail":
        this.log.warn("stage_fail", { reason: outcome.reason, terminal: outcome.terminal === true });
        if (outcome.terminal) return; // swallow → queue completes, no retry
        throw new Error(`stage ${this.name} failed: ${outcome.reason}`); // → redeliver/retry
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Build a NON-EMPTY, attributable failure reason from any thrown value.
 *
 * The old `errMsg` returned `e.message`, which is empty for several common
 * failures — undici aborts (`AbortError` with no message), `new Error()`, errors
 * whose detail lives on `.cause.code` (ECONNREFUSED/ECONNRESET/UND_ERR_*). Those
 * surfaced as `stage_fail reason:""` — the single largest, completely
 * unattributable failure bucket in the prod run. This captures the error NAME, the
 * message, and the transport cause code so every failure carries a usable reason.
 */
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e) || "non-error throw";
  const parts: string[] = [];
  if (e.name && e.name !== "Error") parts.push(e.name);
  if (e.message) parts.push(e.message);
  // undici/node transport detail rides on .cause.code (ECONNREFUSED, UND_ERR_…).
  const cause = (e as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") parts.push(`cause=${code}`);
  }
  const reason = parts.join(": ");
  return reason || e.constructor?.name || "unknown error";
}
