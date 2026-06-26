/**
 * Manifest stage — image lanes only (vision + mistral). The scarcest external
 * budget (42/min per egress IP), so it is rate-gated and skips the HTTP call when
 * the manifest is already in S3.
 *
 *   ManifestReq → IIIF manifest (S3-cached) → canvas list → record plan
 *     (pagesExpected = canvas count) → fan out N image folio items to the fetch queue.
 *
 * Like the metadata stage it has side effects (recordPlan, fan-out) so it does not
 * use the base outcome cache; idempotency comes from the explicit manifest S3 skip
 * + downstream fetch/Monitor idempotency. A canvas-less or permanently-failing
 * manifest fails the doc terminally (no retry) — V1's manifest-500 fix made cheap.
 */
import { PipelineStage, type StageDeps } from "../core/stage.js";
import type { StageContext, StageOutcome } from "../core/types.js";
import { PermanentBnfError } from "../bnf/errors.js";
import type { BnfClient, Manifest } from "../bnf/types.js";
import type { DocStateStore } from "../domain/doc-state.js";
import { keys } from "../domain/keys.js";
import { FETCH_PRIORITY, Q } from "../domain/queues.js";
import type { FolioItem, ManifestReq } from "../domain/types.js";
import type { RateGate } from "../core/types.js";

export interface ManifestOpts {
  /** Max canvases per doc (matches V1 maxImageCanvases / mistral maxPages). */
  maxCanvases?: number;
}

export class ManifestStage extends PipelineStage<ManifestReq, never> {
  readonly name = "manifest";
  readonly inputQueue = Q.manifest;
  override readonly concurrency = 4;
  override readonly rate?: RateGate;

  private readonly maxCanvases: number;

  constructor(
    deps: StageDeps,
    private readonly bnf: BnfClient,
    private readonly docState: DocStateStore,
    rate: RateGate | undefined,
    opts: ManifestOpts = {},
  ) {
    super(deps);
    this.rate = rate;
    this.maxCanvases = opts.maxCanvases ?? 200;
  }

  async process(req: ManifestReq, ctx: StageContext): Promise<StageOutcome<never>> {
    let manifest: Manifest;
    try {
      const cached = await this.blob.getJson<Manifest>(keys.manifest(req.ark));
      manifest = cached ?? (await this.bnf.getManifest(req.ark, this.maxCanvases));
      if (!cached) await this.blob.putJson(keys.manifest(req.ark), manifest);
    } catch (e) {
      if (e instanceof PermanentBnfError) {
        await this.docState.setStatus(req.docJobId, "failed", {
          error: `manifest_unavailable: ${e.cause}`,
        });
        return { kind: "fail", reason: `manifest_unavailable: ${e.cause}`, terminal: true };
      }
      // Transient: retry while attempts remain. On the LAST attempt, mark the doc
      // failed and terminate — otherwise pg-boss fails the job (e.g. the persistent
      // manifest-500 ARKs) but the doc row would orphan in a non-terminal state and
      // never reconcile in the progress model. (Same last-attempt idiom as fetch.)
      if (ctx.attempt >= this.retry.attempts) {
        const reason = `manifest_unavailable_after_retries: ${e instanceof Error ? e.message : String(e)}`;
        await this.docState.setStatus(req.docJobId, "failed", { error: reason });
        return { kind: "fail", reason, terminal: true };
      }
      throw e;
    }

    const canvases = manifest.canvases.slice(0, this.maxCanvases);
    if (canvases.length === 0) {
      await this.docState.setStatus(req.docJobId, "failed", { error: "manifest_no_canvases" });
      return { kind: "fail", reason: "manifest_no_canvases", terminal: true };
    }

    await this.docState.recordPlan(req.docJobId, {
      lane: req.lane,
      pagesExpected: canvases.length,
      meta: req.meta,
    });
    const folios: Array<FolioItem & { priority: number }> = canvases.map((c) => ({
      docJobId: req.docJobId,
      ark: req.ark,
      ordre: c.ordre,
      kind: "image",
      lane: req.lane,
      priority: FETCH_PRIORITY[req.lane],
    }));
    await this.queue.sendMany(Q.fetch, folios);
    ctx.log.info("manifest_fanout", { ark: req.ark, lane: req.lane, folios: canvases.length });
    return { kind: "done" };
  }
}
