/**
 * OCR-quality backfill stage — builds `ocr-quality/<slug>.json` for a document
 * indexed BEFORE the release (plan D6, ai-memories/tech/repos/bnf/
 * feedback-2026-09-29). Fed by POST /ocr-quality/sync (live/ocr-quality-sync.ts)
 * one `{ark}` per missing artifact, deduped and retry-bounded by the
 * OcrBackfillStore (domain/ocr-backfill.ts).
 *
 * Why a pipeline stage and not a script: a text document needs ONE fresh ALTO
 * call per indexed folio (the "alto" cache holds text, not XML — keys.ts), and
 * those calls must share the worker's in-process fetch rate gate FIFO with live
 * ingests. The gate is REQUIRED: an ungated backfill would compete blindly
 * through the broker's shared bucket and the shed 429s would land on live runs.
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
import { PipelineStage, type StageDeps } from "../core/stage.js";
import { acquireWithin, RateGateTimeoutError } from "../core/rate.js";
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

export interface OcrBackfillItem {
  ark: string;
}

/**
 * Longest wait for one fetch-gate token. The gate is shared FIFO with live
 * ingests, so a long queue is normal; a wait beyond this means the gate is
 * saturated — give the delivery back (transient) rather than hold it.
 */
export const OCR_BACKFILL_RATE_WAIT_MS = 120_000;

export interface OcrQualityBackfillOpts {
  /** In-flight docs. Each text doc walks its pages sequentially behind the fetch gate. */
  concurrency: number;
  /** Deadline for one rate-gate token (OCR_BACKFILL_RATE_WAIT_MS in production). */
  rateWaitMs: number;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class OcrQualityBackfillStage extends PipelineStage<OcrBackfillItem, never> {
  readonly name = "ocr-quality-backfill";
  readonly inputQueue = Q.ocrQualityBackfill;
  override readonly concurrency: number;
  // See OCR_BACKFILL_DELIVERY_CEILING_S. Sidecars persist per folio, so an
  // expired delivery loses nothing — the store re-queues the stale row and the
  // redelivery resumes from the last sidecar.
  override readonly expireInSeconds = OCR_BACKFILL_DELIVERY_CEILING_S;
  // 30s base delay: a transient here is almost always a BnF clock-minute
  // window closing (the same reason MetadataStage uses it).
  override readonly queueRetryDelayMs = 30_000;
  /** OCR_BACKFILL_RATE_WAIT_MS — below the base's half-ceiling on purpose (see its doc). */
  private readonly fetchTokenWaitMs: number;

  constructor(
    deps: StageDeps,
    private readonly bnf: BnfClient,
    private readonly store: OcrBackfillStore,
    /** The SAME fetch RateGate FetchStage holds (build.ts `rates.fetch`) —
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
    await this.store.markFailed(item.ark, withDetail(OCR_BACKFILL_REASON.BUILD_FAILED, reason), {
      permanent: false,
    });
  }

  async process(item: OcrBackfillItem, ctx: StageContext): Promise<StageOutcome<never>> {
    const { ark } = item;

    // 0. This delivery starts the build: the staleness clock runs from here.
    //    A row that already left `queued` has no build to run.
    if ((await this.store.markStarted(ark)) === OCR_BACKFILL_MARK.NOT_QUEUED) {
      ctx.log.warn("ocr_backfill_not_queued", { ark, attempt: ctx.attempt });
      return { kind: "done" };
    }

    // 1. Already built (a redelivery, or a live ingest beat us to it). Only a
    //    VALID artifact counts: a corrupt one is rebuilt and overwritten.
    if (await this.hasValidArtifact(ark, ctx)) {
      this.noteMark(ark, await this.store.markDone(ark), ctx);
      return { kind: "done" };
    }

    // 2. The per-ARK meta blob is where ocrRate and the lane come from.
    const rawMeta = await this.blob.getJson<unknown>(keys.metadata(ark));
    if (rawMeta === null) return this.permanent(ark, OCR_BACKFILL_REASON.NO_METADATA, ctx);
    let info: BnfDocInfo;
    try {
      const cached = inspectCachedDocInfo(rawMeta);
      info = cached.info;
      if (cached.unusableTauxOcr !== null) {
        ctx.log.warn("taux_ocr_unusable", { ark, origin: "legacy_cache", ...cached.unusableTauxOcr });
      }
    } catch (e) {
      if (!(e instanceof CorruptDocInfoError)) throw e;
      return this.permanent(ark, withDetail(OCR_BACKFILL_REASON.CORRUPT_METADATA, e.message), ctx);
    }

    // 3. The prepared pages are the set the artifact must cover.
    const pages = await this.blob.getJson<unknown>(keys.pages(ark));
    if (pages === null) return this.permanent(ark, OCR_BACKFILL_REASON.NO_PAGES_ARTIFACT, ctx);
    if (!isPreparedPages(pages)) return this.permanent(ark, OCR_BACKFILL_REASON.CORRUPT_PAGES_ARTIFACT, ctx);
    if (pages.length === 0) return this.permanent(ark, OCR_BACKFILL_REASON.NO_PAGES_ARTIFACT, ctx);

    // 4. The lane that produced an INDEXED doc is deterministic from its info:
    //    a sans_texte doc that has pages was transcribed by paid OCR.
    const decision = classifyLane(info, { mistralEnabled: true });
    if (decision.kind === "skip") return this.permanent(ark, OCR_BACKFILL_REASON.UNCLASSIFIABLE, ctx);

    try {
      if (decision.lane === "text") {
        const beforeFetch = (): Promise<void> => acquireWithin(this.fetchRate, this.fetchTokenWaitMs);
        for (const page of pages) {
          await ensureAltoFolio(
            { bnf: this.bnf, blob: this.blob, log: ctx.log, beforeFetch },
            ark,
            page.ordre,
          );
        }
      }
      await writeOcrQualityArtifact(this.blob, { ark, lane: decision.lane, pages });
    } catch (e) {
      if (e instanceof PermanentBnfError || e instanceof OcrQualityArtifactError) {
        ctx.log.warn("ocr_backfill_permanent", { ark, error: errMsg(e) });
        return this.permanent(ark, withDetail(OCR_BACKFILL_REASON.BUILD_FAILED, errMsg(e)), ctx);
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
        this.noteMark(ark, await this.store.markFailed(ark, reason, { permanent: false }), ctx);
        return { kind: "fail", reason, terminal: true };
      }
      throw e;
    }

    this.noteMark(ark, await this.store.markDone(ark), ctx);
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
  private async permanent(ark: string, reason: string, ctx: StageContext): Promise<StageOutcome<never>> {
    this.noteMark(ark, await this.store.markFailed(ark, reason, { permanent: true }), ctx);
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
