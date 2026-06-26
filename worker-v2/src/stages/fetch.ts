/**
 * BnF fetch stage — the binding constraint (300/min per egress IP, the broker's
 * shared bucket). One message = ONE folio fetch (ALTO xml or IIIF image). Heavy
 * bytes go to S3; a tiny FolioResult pointer goes to the Monitor for fan-in.
 *
 * Invariant that the whole fan-in depends on: this stage emits EXACTLY ONE
 * FolioResult per folio, always — success, legitimately-empty, or lost. If a
 * folio fetch were ever to die without emitting, the Monitor's per-doc counter
 * would never reach `pages_expected` and the doc would hang forever. So:
 *   - transient error + attempts remain → throw (the queue retries with backoff);
 *   - transient error on the LAST attempt → emit `ok:false` (folio lost, fed to
 *     the doc's fail-ratio) instead of throwing;
 *   - permanent error (403/404 doc-level) → emit `ok:false` immediately, no retry.
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
import { PermanentBnfError } from "../bnf/errors.js";
import type { BnfClient } from "../bnf/types.js";
import { keys } from "../domain/keys.js";
import { Q } from "../domain/queues.js";
import type { FolioItem, FolioResult } from "../domain/types.js";

export interface FetchOpts {
  /** IIIF size token for image folios (V1: "max" — never "!2000,2000", which 400s). */
  imageSize?: string;
}

export class FetchStage extends PipelineStage<FolioItem, FolioResult> {
  readonly name = "fetch";
  readonly inputQueue = Q.fetch;
  override readonly outputQueue = Q.monitor;
  override readonly concurrency: number;
  override readonly rate?: RateGate;

  private readonly imageSize: string;

  constructor(
    deps: StageDeps,
    private readonly bnf: BnfClient,
    rate: RateGate | undefined,
    opts: FetchOpts & { concurrency?: number } = {},
  ) {
    super(deps);
    this.rate = rate;
    this.concurrency = opts.concurrency ?? 12;
    this.imageSize = opts.imageSize ?? "max";
  }

  async process(item: FolioItem, ctx: StageContext): Promise<StageOutcome<FolioResult>> {
    try {
      if (item.kind === "alto") return await this.fetchAlto(item);
      return await this.fetchImage(item);
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

  private async fetchAlto(item: FolioItem): Promise<StageOutcome<FolioResult>> {
    const key = keys.alto(item.ark, item.ordre);
    const cached = await this.blob.getBytes(key);
    if (!cached) {
      const folio = await this.bnf.fetchAltoFolio(item.ark, item.ordre);
      await this.blob.putBytes(key, Buffer.from(folio.text, "utf8"), "text/plain; charset=utf-8");
      return this.ok(item, folio.empty);
    }
    return this.ok(item, cached.length === 0);
  }

  private async fetchImage(item: FolioItem): Promise<StageOutcome<FolioResult>> {
    const key = keys.image(item.ark, item.ordre);
    const cached = await this.blob.getBytes(key);
    if (!cached) {
      const bytes = await this.bnf.fetchImageFolio(item.ark, item.ordre, this.imageSize);
      await this.blob.putBytes(key, bytes, "image/jpeg");
    }
    return this.ok(item, false);
  }

  private ok(item: FolioItem, empty: boolean): StageOutcome<FolioResult> {
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
