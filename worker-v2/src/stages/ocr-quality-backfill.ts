/**
 * OCR-quality backfill stage — builds `ocr-quality/<slug>.json` for a document
 * indexed BEFORE the release (plan D6, ai-memories/tech/repos/bnf/
 * feedback-2026-09-29). Fed by POST /ocr-quality/sync (live/ocr-quality-sync.ts)
 * one `{ark}` per missing artifact, deduped by the OcrBackfillStore.
 *
 * Why a pipeline stage and not a script: a text document needs ONE fresh ALTO
 * call per indexed folio (the "alto" cache holds text, not XML — keys.ts), and
 * those calls must share the worker's in-process fetch rate gate FIFO with live
 * ingests. A standalone script would compete blindly through the broker's
 * shared bucket and the shed 429s would land on live runs.
 *
 * Bounded three ways: OCR_BACKFILL_CONCURRENCY (in-flight docs), one row per
 * ARK in the store, and expireInSeconds as the wall-clock ceiling. Idempotent:
 * the artifact's presence means done; each sidecar's presence means that folio
 * is done, so a redelivery (or an app re-request after a failure) resumes
 * where the last build stopped instead of re-spending quota.
 */
import { PipelineStage, type StageDeps } from "../core/stage.js";
import type { RateGate, StageContext, StageOutcome } from "../core/types.js";
import { classifyLane } from "../bnf/classify.js";
import { normalizeCachedDocInfo } from "../bnf/doc-info.js";
import { PermanentBnfError } from "../bnf/errors.js";
import type { BnfClient, BnfDocInfo } from "../bnf/types.js";
import { keys } from "../domain/keys.js";
import type { OcrBackfillStore } from "../domain/ocr-backfill.js";
import { Q } from "../domain/queues.js";
import { ensureAltoFolio } from "./alto-folio.js";
import { isPreparedPages, writeOcrQualityArtifact } from "./ocr-quality.js";

export interface OcrBackfillItem {
  ark: string;
}

export interface OcrQualityBackfillOpts {
  /** In-flight docs. Each text doc walks its pages sequentially behind the fetch gate. */
  concurrency: number;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class OcrQualityBackfillStage extends PipelineStage<OcrBackfillItem, never> {
  readonly name = "ocr-quality-backfill";
  readonly inputQueue = Q.ocrQualityBackfill;
  override readonly concurrency: number;
  // 3600s: a 300-folio worst case, each folio waiting its turn on the shared
  // fetch gate behind live ingests, plus one ALTO fetch (≤ 135s) each. Sidecars
  // persist per folio, so an expired delivery loses nothing — the redelivery
  // resumes from the last written sidecar.
  override readonly expireInSeconds = 3600;
  // 30s base delay: a transient here is almost always a BnF clock-minute
  // window closing (the same reason MetadataStage uses it).
  override readonly queueRetryDelayMs = 30_000;

  constructor(
    deps: StageDeps,
    private readonly bnf: BnfClient,
    private readonly store: OcrBackfillStore,
    /** The SAME fetch RateGate FetchStage holds (build.ts `rates.fetch`) — the
     *  whole point of running this as a stage. Acquired per BnF call, never on
     *  a cache hit (ensureAltoFolio's `beforeFetch`). */
    private readonly fetchRate: RateGate | undefined,
    opts: OcrQualityBackfillOpts,
  ) {
    super(deps);
    this.concurrency = opts.concurrency;
  }

  /** The base's safety net: a throw that escaped process() on the last attempt. */
  protected override async onExhausted(item: OcrBackfillItem, reason: string): Promise<void> {
    await this.store.markFailed(item.ark, `build_failed: ${reason}`, { permanent: false });
  }

  async process(item: OcrBackfillItem, ctx: StageContext): Promise<StageOutcome<never>> {
    const { ark } = item;

    // 1. Already built (a redelivery, or a live ingest beat us to it).
    if (await this.blob.has(keys.ocrQuality(ark))) {
      await this.store.markDone(ark);
      return { kind: "done" };
    }

    // 2. The per-ARK meta blob is where ocrRate and the lane come from.
    const rawMeta = await this.blob.getJson<unknown>(keys.metadata(ark));
    if (rawMeta === null) return this.terminal(ark, "no_metadata");
    let info: BnfDocInfo;
    try {
      info = normalizeCachedDocInfo(rawMeta);
    } catch (e) {
      return this.terminal(ark, `build_failed: ${errMsg(e)}`);
    }

    // 3. The prepared pages are the set the artifact must cover.
    const pages = await this.blob.getJson<unknown>(keys.pages(ark));
    if (pages === null) return this.terminal(ark, "no_pages_artifact");
    if (!isPreparedPages(pages)) {
      return this.terminal(ark, "build_failed: corrupt pages artifact");
    }
    if (pages.length === 0) return this.terminal(ark, "no_pages_artifact");

    // 4. The lane that produced an INDEXED doc is deterministic from its info:
    //    a sans_texte doc that has pages was transcribed by paid OCR.
    const decision = classifyLane(info, { mistralEnabled: true });
    if (decision.kind === "skip") return this.terminal(ark, "unclassifiable");

    try {
      if (decision.lane === "text") {
        const rate = this.fetchRate;
        const beforeFetch = rate ? () => rate.acquire() : undefined;
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
      if (e instanceof PermanentBnfError) {
        ctx.log.warn("ocr_backfill_permanent", { ark, cause: e.cause });
        return this.terminal(ark, `build_failed: ${e.message}`);
      }
      // Transient: retry while attempts remain; on the last attempt record the
      // failure so the app sees `unavailable` with a reason instead of a row
      // stuck in `queued` forever. Sidecars written so far are kept.
      if (ctx.attempt >= this.retry.attempts) {
        ctx.log.warn("ocr_backfill_exhausted", { ark, attempt: ctx.attempt, error: errMsg(e) });
        return this.terminal(ark, `build_failed: ${errMsg(e)}`);
      }
      throw e;
    }

    await this.store.markDone(ark);
    ctx.log.info("ocr_quality_backfilled", { ark, lane: decision.lane, folios: pages.length });
    return { kind: "done" };
  }

  private async terminal(ark: string, reason: string): Promise<StageOutcome<never>> {
    await this.store.markFailed(ark, reason, { permanent: true });
    return { kind: "fail", reason, terminal: true };
  }
}
