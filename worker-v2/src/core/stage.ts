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
    });
    this.log.info("stage_started", {
      queue: this.inputQueue,
      out: this.outputQueue ?? null,
      concurrency: this.concurrency,
      rate: this.rate?.ratePerMin ?? null,
    });
  }

  private async handle(msg: QueueMessage<In>): Promise<void> {
    const ctx: StageContext = {
      blob: this.blob,
      log: this.log.child({ msg: msg.id, attempt: msg.attempts }),
      messageId: msg.id,
      attempt: msg.attempts,
    };

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

    // Last-delivery safety net: a non-terminal fail on the FINAL attempt means
    // retries are exhausted. Without this, the doc would stay in a non-terminal
    // status forever (the queue marks the message failed, but nothing marks the
    // DOC) and the run could never complete. Give the stage a chance to mark its
    // doc failed (onExhausted). The outcome is left non-terminal so the queue
    // still records the message failure exactly as before.
    if (
      outcome.kind === "fail" &&
      outcome.terminal !== true &&
      msg.attempts >= this.retry.attempts
    ) {
      await this.onExhausted(msg.payload, outcome.reason).catch((err) =>
        this.log.error("on_exhausted_failed", { error: errMsg(err) }),
      );
      this.log.warn("stage_exhausted", { reason: outcome.reason, attempts: msg.attempts });
    }

    if (key && (outcome.kind === "emit" || outcome.kind === "done")) {
      await this.blob.putJson(key, outcome);
    }
    await this.dispatch(outcome, msg.payload, false);
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
