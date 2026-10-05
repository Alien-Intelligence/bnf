/**
 * OCR-quality backfill stage — builds `ocr-quality/<slug>.json` for a document
 * indexed BEFORE the release (plan D6, ai-memories/tech/repos/bnf/
 * feedback-2026-09-29). Fed by POST /ocr-quality/sync (live/ocr-quality-sync.ts)
 * one `{ark}` per missing artifact, deduped and retry-bounded by the
 * OcrBackfillStore (domain/ocr-backfill.ts).
 *
 * Why a pipeline stage and not a script: a text document needs ONE fresh ALTO
 * call per indexed folio (the "alto" cache holds text, not XML — keys.ts), and
 * those calls must share the worker's in-process ALTO fetch gate (presentation
 * ∧ global) FIFO with live ingests. The gate is REQUIRED: an ungated backfill
 * would compete blindly through the broker's buckets and the shed 429s would
 * land on live runs.
 *
 * Bounded four ways: OCR_BACKFILL_CONCURRENCY (in-flight docs), one row per ARK
 * in the store, OCR_BACKFILL_RATE_WAIT_MS per token wait, and expireInSeconds
 * (OCR_BACKFILL_DELIVERY_CEILING_S) as the wall-clock ceiling. Every delivery
 * stamps the row's `startedAt` first: when pg-boss expires a delivery no
 * handler runs, and the store re-queues the row once it is stale measured from
 * that start (OCR_BACKFILL_STARTED_STALE_MS) — never from the enqueue, so a
 * long backlog is not an expiry — counting the attempt, so no ARK stays
 * `building` forever. A delivery whose row already left `queued` (a stray or
 * late redelivery) builds nothing and flips nothing.
 *
 * Idempotent: a VALID artifact means done (a corrupt one is rebuilt); each
 * sidecar's presence means that folio is done, so a redelivery resumes where
 * the last build stopped instead of re-spending quota.
 *
 * Failure classes (each recorded with its permanence, never guessed):
 *   - permanent (never retried): no metadata, corrupt metadata, no or corrupt
 *     pages artifact, unclassifiable, a PermanentBnfError, an
 *     OcrQualityArtifactError;
 *   - transient (retried by the queue, then by the store's backoff): a
 *     TransientBnfError, a rate-gate wait past its deadline (RateGateTimeoutError);
 *   - unclassified (an S3 or DB blip): retried like a transient, logged as such.
 */
import { DeliveryExpiredError, PipelineStage, type StageDeps } from "../core/stage.js";
import { acquireWithin, RateGateStoppedError, RateGateTimeoutError } from "../core/rate.js";
import type { RateGate, StageContext, StageOutcome } from "../core/types.js";
import { classifyLane } from "../bnf/classify.js";
import { CorruptDocInfoError, inspectCachedDocInfo } from "../bnf/doc-info.js";
import { PermanentBnfError, TransientBnfError } from "../bnf/errors.js";
import type { BnfClient, BnfDocInfo } from "../bnf/types.js";
import { keys } from "../domain/keys.js";
import {
  OCR_BACKFILL_DELIVERY_CEILING_S,
  OCR_BACKFILL_MARK,
  OCR_BACKFILL_REASON,
  withDetail,
  type OcrBackfillClaim,
  type OcrBackfillMark,
  type OcrBackfillStore,
} from "../domain/ocr-backfill.js";
import { Q } from "../domain/queues.js";
import { ensureAltoFolio } from "./alto-folio.js";
import {
  isDocOcrQuality,
  isPreparedPages,
  OcrQualityArtifactError,
  writeOcrQualityArtifact,
} from "./ocr-quality.js";

/** The backfill message: the claim the sync won (OcrBackfillClaim). */
export type OcrBackfillItem = OcrBackfillClaim;

/**
 * A queued payload as the claim it carries, or null for a stray message. A
 * message queued BEFORE claims existed carries only `{ark}`: it is generation
 * 0 — the column default every pre-deploy row got — so it still builds the
 * pre-deploy row it was sent for, at no attempt cost.
 */
export function toClaim(v: unknown): OcrBackfillClaim | null {
  if (v === null || typeof v !== "object" || !("ark" in v) || typeof v.ark !== "string") return null;
  if (!("generation" in v) || v.generation === undefined) return { ark: v.ark, generation: PRE_CLAIM_GENERATION };
  const { generation } = v;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) return null;
  return { ark: v.ark, generation };
}

/** The generation of a row created before claims existed (schema.sql column default). */
export const PRE_CLAIM_GENERATION = 0;

/**
 * Longest wait for one fetch-gate token. The gate is shared FIFO with live
 * ingests, so a long queue is normal; a wait beyond this means the gate is
 * saturated — give the delivery back (transient) rather than hold it.
 */
export const OCR_BACKFILL_RATE_WAIT_MS = 120_000;

/**
 * Base delay before a backfill redelivery: above the worst-case ALTO fetch
 * still in flight from the delivery it replaces — the client's 135 s page
 * timeout (BNF_PAGE_TIMEOUT_MS default) plus the broker client's one 1 s
 * reconnect, with margin.
 */
export const OCR_BACKFILL_RETRY_DELAY_MS = 150_000;

export interface OcrQualityBackfillOpts {
  /** In-flight docs. Each text doc walks its pages sequentially behind the fetch gate. */
  concurrency: number;
  /** Deadline for one rate-gate token (OCR_BACKFILL_RATE_WAIT_MS in production). */
  rateWaitMs: number;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A permanent BnF failure on ONE folio: recorded with that folio, never just "the doc". */
class FolioPermanentError extends Error {
  constructor(
    readonly folio: number,
    override readonly cause: PermanentBnfError,
  ) {
    super(`f${folio}: ${cause.message}`);
    this.name = "FolioPermanentError";
  }
}

export class OcrQualityBackfillStage extends PipelineStage<OcrBackfillItem, never> {
  readonly name = "ocr-quality-backfill";
  readonly inputQueue = Q.ocrQualityBackfill;
  override readonly concurrency: number;
  // See OCR_BACKFILL_DELIVERY_CEILING_S. Sidecars persist per folio, so an
  // expired delivery loses nothing — the store re-queues the stale row and the
  // redelivery resumes from the last sidecar.
  override readonly expireInSeconds = OCR_BACKFILL_DELIVERY_CEILING_S;
  // At least the worst-case in-flight ALTO fetch (OCR_BACKFILL_RETRY_DELAY_MS):
  // a redelivery of the SAME claim (generation) can never overlap a fetch the
  // expired delivery still has in flight, even though a sent fetch is not
  // aborted — it finishes within its timeout and its answer is discarded.
  override readonly queueRetryDelayMs = OCR_BACKFILL_RETRY_DELAY_MS;
  /** OCR_BACKFILL_RATE_WAIT_MS — below the base's half-ceiling on purpose (see its doc). */
  private readonly fetchTokenWaitMs: number;

  constructor(
    deps: StageDeps,
    private readonly bnf: BnfClient,
    private readonly store: OcrBackfillStore,
    /** The SAME ALTO RateGate FetchAltoStage holds (build.ts `rates.fetchAlto`) —
     *  required: the whole point of running this as a stage. Acquired per BnF
     *  call, never on a cache hit (ensureAltoFolio's `beforeFetch`). */
    private readonly fetchRate: RateGate,
    opts: OcrQualityBackfillOpts,
  ) {
    super(deps);
    this.concurrency = opts.concurrency;
    this.fetchTokenWaitMs = opts.rateWaitMs;
  }

  /** The base's safety net: a throw that escaped process() on the last attempt. */
  protected override async onExhausted(item: OcrBackfillItem, reason: string): Promise<void> {
    const claim = toClaim(item);
    if (claim === null) return;
    await this.store.markFailed(claim, withDetail(OCR_BACKFILL_REASON.BUILD_FAILED, reason), {
      permanent: false,
    });
  }

  async process(item: OcrBackfillItem, ctx: StageContext): Promise<StageOutcome<never>> {
    // A payload that names no claim (not even a pre-claim `{ark}`) can mark no
    // row: nothing to build.
    const claim = toClaim(item);
    if (claim === null) {
      ctx.log.warn("ocr_backfill_bad_payload", { payload: JSON.stringify(item) });
      return { kind: "fail", reason: "ocr_backfill_bad_payload", terminal: true };
    }
    const { ark } = claim;

    // 0. This delivery starts the build: the staleness clock runs from here.
    //    A row that already left this claim (terminal, or re-opened under a
    //    newer generation) has no build to run.
    if ((await this.store.markStarted(claim)) === OCR_BACKFILL_MARK.NOT_QUEUED) {
      ctx.log.warn("ocr_backfill_not_queued", { ark, generation: claim.generation, attempt: ctx.attempt });
      return { kind: "done" };
    }

    // 1. Already built (a redelivery, or a live ingest beat us to it). Only a
    //    VALID artifact counts: a corrupt one is rebuilt and overwritten.
    if (await this.hasValidArtifact(ark, ctx)) {
      this.noteMark(ark, await this.store.markDone(claim), ctx);
      return { kind: "done" };
    }

    // 2. The per-ARK meta blob is where ocrRate and the lane come from.
    const rawMeta = await this.blob.getJson<unknown>(keys.metadata(ark));
    if (rawMeta === null) return this.permanent(claim, OCR_BACKFILL_REASON.NO_METADATA, ctx);
    let info: BnfDocInfo;
    try {
      const cached = inspectCachedDocInfo(rawMeta);
      info = cached.info;
      if (cached.unusableTauxOcr !== null) {
        ctx.log.warn("taux_ocr_unusable", { ark, origin: "legacy_cache", ...cached.unusableTauxOcr });
      }
    } catch (e) {
      if (!(e instanceof CorruptDocInfoError)) throw e;
      return this.permanent(claim, withDetail(OCR_BACKFILL_REASON.CORRUPT_METADATA, e.message), ctx);
    }

    // 3. The prepared pages are the set the artifact must cover.
    const pages = await this.blob.getJson<unknown>(keys.pages(ark));
    if (pages === null) return this.permanent(claim, OCR_BACKFILL_REASON.NO_PAGES_ARTIFACT, ctx);
    if (!isPreparedPages(pages)) return this.permanent(claim, OCR_BACKFILL_REASON.CORRUPT_PAGES_ARTIFACT, ctx);
    if (pages.length === 0) return this.permanent(claim, OCR_BACKFILL_REASON.NO_PAGES_ARTIFACT, ctx);

    // 4. The lane that produced an INDEXED doc is deterministic from its info:
    //    a sans_texte doc that has pages was transcribed by paid OCR.
    const decision = classifyLane(info, { mistralEnabled: true });
    if (decision.kind === "skip") return this.permanent(claim, OCR_BACKFILL_REASON.UNCLASSIFIABLE, ctx);

    try {
      if (decision.lane === "text") {
        // The delivery's ceiling (ctx.signal) stops the walk: between folios
        // and during every gate wait. A fetch already sent finishes within its
        // own timeout; sidecars written so far are kept for the redelivery.
        const beforeFetch = (): Promise<void> =>
          acquireWithin(this.fetchRate, this.fetchTokenWaitMs, ctx.signal);
        for (const page of pages) {
          ctx.signal.throwIfAborted();
          try {
            await ensureAltoFolio(
              { bnf: this.bnf, blob: this.blob, log: ctx.log, beforeFetch, signal: ctx.signal },
              ark,
              page.ordre,
            );
          } catch (e) {
            if (e instanceof PermanentBnfError) throw new FolioPermanentError(page.ordre, e);
            throw e;
          }
        }
      }
      // Past the ceiling, the abandoned walk writes nothing more.
      ctx.signal.throwIfAborted();
      await writeOcrQualityArtifact(this.blob, { ark, lane: decision.lane, pages });
      ctx.signal.throwIfAborted();
    } catch (e) {
      // A stopped gate (shutdown) is handed back by the stage base; a passed
      // ceiling is the base's to report — neither is this build's failure.
      if (e instanceof RateGateStoppedError || e instanceof DeliveryExpiredError) throw e;
      if (e instanceof FolioPermanentError) {
        ctx.log.warn("ocr_backfill_permanent", { ark, folio: e.folio, error: errMsg(e.cause) });
        return this.permanent(claim, withDetail(OCR_BACKFILL_REASON.BUILD_FAILED, e.message), ctx);
      }
      if (e instanceof PermanentBnfError || e instanceof OcrQualityArtifactError) {
        ctx.log.warn("ocr_backfill_permanent", { ark, error: errMsg(e) });
        return this.permanent(claim, withDetail(OCR_BACKFILL_REASON.BUILD_FAILED, errMsg(e)), ctx);
      }
      if (!(e instanceof TransientBnfError || e instanceof RateGateTimeoutError)) {
        ctx.log.warn("ocr_backfill_unclassified_error", { ark, attempt: ctx.attempt, error: errMsg(e) });
      }
      // Transient (or unclassified): retry while attempts remain; on the last
      // one record a RETRYABLE failure — the store re-opens it after its
      // backoff — instead of leaving the row queued. Sidecars so far are kept.
      if (ctx.attempt >= this.retry.attempts) {
        ctx.log.warn("ocr_backfill_exhausted", { ark, attempt: ctx.attempt, error: errMsg(e) });
        const reason = withDetail(OCR_BACKFILL_REASON.BUILD_FAILED, errMsg(e));
        this.noteMark(ark, await this.store.markFailed(claim, reason, { permanent: false }), ctx);
        return { kind: "fail", reason, terminal: true };
      }
      throw e;
    }

    this.noteMark(ark, await this.store.markDone(claim), ctx);
    ctx.log.info("ocr_quality_backfilled", { ark, lane: decision.lane, folios: pages.length });
    return { kind: "done" };
  }

  private async hasValidArtifact(ark: string, ctx: StageContext): Promise<boolean> {
    const bytes = await this.blob.getBytes(keys.ocrQuality(ark));
    if (bytes === null) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      parsed = null;
    }
    if (isDocOcrQuality(parsed, ark)) return true;
    ctx.log.warn("ocr_quality_artifact_corrupt", { ark, key: keys.ocrQuality(ark) });
    return false;
  }

  /** A failure no retry can fix: recorded permanent, the message completes. */
  private async permanent(
    claim: OcrBackfillClaim,
    reason: string,
    ctx: StageContext,
  ): Promise<StageOutcome<never>> {
    this.noteMark(claim.ark, await this.store.markFailed(claim, reason, { permanent: true }), ctx);
    return { kind: "fail", reason, terminal: true };
  }

  /**
   * A mark that found the row no longer queued (another delivery, or a sync,
   * finished it meanwhile) changed nothing — said so, never silently.
   */
  private noteMark(ark: string, mark: OcrBackfillMark, ctx: StageContext): void {
    if (mark === OCR_BACKFILL_MARK.NOT_QUEUED) {
      ctx.log.warn("ocr_backfill_mark_not_queued", { ark, attempt: ctx.attempt });
    }
  }
}
