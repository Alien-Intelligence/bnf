/**
 * BnF fetch stages — the binding constraint. One message = ONE folio fetch.
 * Heavy bytes go to S3; a tiny FolioResult pointer goes to the Monitor for
 * fan-in. Two stages on two queues, each with its own rate gate and
 * concurrency (Track D):
 *
 *   - FetchAltoStage  on Q.fetchAlto  — ALTO text, Presentation API
 *                                        (gate: presentation ∧ global);
 *   - FetchImageStage on Q.fetchImage — images, Image API (gate: image ∧ global).
 *
 * Split because the Image quota (300/min) is five times scarcer than the
 * Presentation one: in one images-first queue, items waiting on the image gate
 * would hold every concurrency slot and starve ALTO.
 *
 * Invariant that the whole fan-in depends on: a folio produces EXACTLY ONE
 * FolioResult, always — success, legitimately-empty, or lost. If a folio fetch
 * were ever to die without emitting, the Monitor's per-doc counter would never
 * reach `pages_expected` and the doc would hang forever. So:
 *   - transient error + attempts remain → throw (the queue retries with backoff);
 *   - transient error on the LAST attempt → emit `ok:false` (folio lost, fed to
 *     the doc's fail-ratio) instead of throwing;
 *   - permanent error (403/404 doc-level) → emit `ok:false` immediately, no retry;
 *   - an image item reaching the ALTO stage (a message enqueued on the shared
 *     queue before the split) is FORWARDED to the image queue and emits nothing
 *     here — the image stage emits its one result.
 *
 * Idempotency/resume comes from the BYTES in S3, not the base outcome cache: the
 * cached outcome embeds the FolioResult's `docJobId`, so replaying it on a
 * re-ingest under a NEW job would record the folio against the OLD job and the
 * fan-in would hang (live bug, 2026-06-26). Instead `process()` always runs,
 * checks the alto/image S3 key (skip the scarce BnF call on a hit), and emits a
 * FRESH FolioResult built from the incoming item's identity. The Monitor dedupes
 * per (docJobId, ordre), so re-emit on redelivery is safe.
 */
import { PipelineStage, type StageDeps } from "../core/stage.js";
import type { RateGate, StageContext, StageOutcome } from "../core/types.js";
import { PermanentBnfError, TransientBnfError } from "../bnf/errors.js";
import {
  cachedImageCovers,
  iiifSizeFor,
  jpegDimensions,
  maxEdgeForLane,
  type ImageLane,
} from "../bnf/image-size.js";
import type { BnfClient } from "../bnf/types.js";
import { keys } from "../domain/keys.js";
import { Q, sendFolios } from "../domain/queues.js";
import type { FolioItem, FolioResult } from "../domain/types.js";
import { ensureAltoFolio } from "./alto-folio.js";

export interface FetchOpts {
  /** In-flight fetches of this stage (BNF_ALTO_FETCH_CONCURRENCY / BNF_IMAGE_FETCH_CONCURRENCY). */
  concurrency: number;
}

/** The shared lifecycle of both fetch stages: the one-FolioResult invariant. */
abstract class FetchStageBase extends PipelineStage<FolioItem, FolioResult> {
  override readonly outputQueue = Q.monitor;
  override readonly concurrency: number;
  override readonly rate?: RateGate;
  // 600s: the base-class `rate` acquire (a wait on the stage's composite gate)
  // plus ONE folio fetch at BNF_PAGE_TIMEOUT_MS (135s, above the broker's 120s)
  // plus the S3 read/write around it. Generous on purpose — expiring a folio
  // fetch loses the FolioResult the fan-in is waiting for.
  override readonly expireInSeconds = 600;

  constructor(
    deps: StageDeps,
    protected readonly bnf: BnfClient,
    rate: RateGate | undefined,
    opts: FetchOpts,
  ) {
    super(deps);
    this.rate = rate;
    this.concurrency = opts.concurrency;
  }

  /** Fetch (or reuse) one folio of this stage's kind. */
  protected abstract fetchFolio(item: FolioItem, ctx: StageContext): Promise<StageOutcome<FolioResult>>;

  async process(item: FolioItem, ctx: StageContext): Promise<StageOutcome<FolioResult>> {
    try {
      return await this.fetchFolio(item, ctx);
    } catch (e) {
      if (e instanceof PermanentBnfError) {
        ctx.log.warn("folio_permanent", { ark: item.ark, ordre: item.ordre, cause: e.cause });
        return this.lost(item);
      }
      // Transient: retry while attempts remain; on the last attempt emit a loss so
      // the doc can still complete (fail-ratio decides whether the doc survives).
      if (ctx.attempt >= this.retry.attempts) {
        ctx.log.warn("folio_lost_exhausted", {
          ark: item.ark,
          ordre: item.ordre,
          attempt: ctx.attempt,
        });
        return this.lost(item);
      }
      throw e;
    }
  }

  protected ok(item: FolioItem, empty: boolean): StageOutcome<FolioResult> {
    const r: FolioResult = {
      docJobId: item.docJobId,
      ark: item.ark,
      ordre: item.ordre,
      lane: item.lane,
      ok: true,
      empty,
    };
    return { kind: "emit", items: [r] };
  }

  private lost(item: FolioItem): StageOutcome<FolioResult> {
    const r: FolioResult = {
      docJobId: item.docJobId,
      ark: item.ark,
      ordre: item.ordre,
      lane: item.lane,
      ok: false,
    };
    return { kind: "emit", items: [r] };
  }
}

/** ALTO folios (text lane), on the Presentation API. */
export class FetchAltoStage extends FetchStageBase {
  readonly name = "fetchAlto";
  readonly inputQueue = Q.fetchAlto;

  /**
   * Text + WC-sidecar as one cached unit (stages/alto-folio.ts, D15). No
   * `beforeFetch`: the stage base already acquired this delivery's rate token.
   */
  protected async fetchFolio(item: FolioItem, ctx: StageContext): Promise<StageOutcome<FolioResult>> {
    if (item.kind === "image") {
      // Enqueued on the shared fetch queue before the split (this queue keeps
      // its name, D6). Its result belongs to the image stage.
      await sendFolios(this.queue, [item]);
      ctx.log.info("fetch_item_forwarded", { ark: item.ark, ordre: item.ordre, lane: item.lane });
      return { kind: "done" };
    }
    const folio = await ensureAltoFolio(
      { bnf: this.bnf, blob: this.blob, log: this.log, signal: ctx.signal },
      item.ark,
      item.ordre,
    );
    return this.ok(item, folio.text.trim() === "");
  }
}

/** Image folios (vision + mistral lanes), on the Image API, sized per canvas. */
export class FetchImageStage extends FetchStageBase {
  readonly name = "fetchImage";
  readonly inputQueue = Q.fetchImage;

  protected async fetchFolio(item: FolioItem, ctx: StageContext): Promise<StageOutcome<FolioResult>> {
    if (item.kind !== "image") {
      // Nothing produces this (sendFolios routes by kind): a wiring error,
      // reported as this folio's permanent loss so its doc still completes.
      throw new PermanentBnfError("config", { hint: `${item.ark} f${item.ordre}: an ALTO item on ${this.inputQueue}` });
    }
    const lane = imageLaneOf(item);
    const key = keys.image(item.ark, item.ordre);
    const cached = await this.blob.getBytes(key);
    if (cached) {
      if (!isCompleteJpeg(cached)) {
        // A poisoned cache entry (see isCompleteJpeg). Trusting it would poison
        // every downstream consumer (Mistral 400s the whole batch entry; vision
        // describes garbage).
        await this.blob.delete(key);
      } else if (cachedImageCovers(lane, cached, item.canvas)) {
        return this.ok(item, false);
      } else {
        // F-D4: the cache key ignores the size, so a downscaled image cached
        // for vision must not stand in for an OCR image.
        ctx.log.warn("image_cache_undersized", {
          ark: item.ark,
          ordre: item.ordre,
          lane,
          cached: jpegDimensions(cached),
          canvas: item.canvas ?? null,
        });
        await this.blob.delete(key);
      }
    }

    let size = iiifSizeFor(maxEdgeForLane(lane), item.canvas);
    if (size === null) {
      // No usable canvas dims (a message from before this release, or a
      // malformed manifest): `max` is always a valid IIIF size.
      ctx.log.warn("image_dims_unknown", { ark: item.ark, ordre: item.ordre, canvas: item.canvas ?? null });
      size = "max";
    }
    const bytes = await this.bnf.fetchImageFolio(item.ark, item.ordre, size);
    if (!isCompleteJpeg(bytes)) {
      // NEVER cache unvalidated bytes. A truncated body reaches us when an
      // upstream chunked response closes cleanly mid-stream (observed
      // 2026-08-13: tunnel/OOM-era broker forwarded partial BnF bodies as
      // complete; the cached JPEGs had headers but no EOI, and every later
      // run inherited them — Mistral rejected whole batches with per-entry
      // 400s). Transient: the retry re-fetches.
      throw new TransientBnfError("image_truncated", {
        hint: `${item.ark} f${item.ordre}: ${bytes.length} bytes, JPEG EOI marker missing`,
      });
    }
    await this.blob.putBytes(key, bytes, "image/jpeg");
    return this.ok(item, false);
  }
}

/** The image lane of an image folio; a text-lane image item is a wiring error. */
function imageLaneOf(item: FolioItem): ImageLane {
  if (item.lane === "text") {
    throw new PermanentBnfError("config", { hint: `${item.ark} f${item.ordre}: an image folio on the text lane` });
  }
  return item.lane;
}

/**
 * Is `bytes` a structurally COMPLETE JPEG — SOI magic at the start and the EOI
 * marker (ffd9) within the trailing window?
 *
 * This is the cheap validity gate between "bytes arrived" and "bytes become a
 * permanent cache entry". A transport that ends a chunked body with a clean
 * close (dying broker, flaky tunnel) yields a prefix that LOOKS like a JPEG
 * (valid header) but cannot be decoded — and once cached, every later run
 * inherits it (2026-08-13: 39 prod docs failed on Mistral per-entry 400s from
 * exactly this). The EOI is checked within a small trailing window, not just
 * the last two bytes, because encoders may pad after EOI.
 */
export function isCompleteJpeg(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false; // SOI
  const tail = bytes.subarray(Math.max(0, bytes.length - 32));
  return tail.includes(Buffer.from([0xff, 0xd9])); // EOI in the trailing window
}
