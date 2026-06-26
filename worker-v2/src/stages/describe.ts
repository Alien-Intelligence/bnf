/**
 * Describe stage — vision lane. The doc's IIIF image folios are all in S3. Run
 * each through the Describer (Holo/Gemini) to produce a textual description per
 * folio, persist the pages, and emit a PreparedDoc to the embedding queue.
 *
 * A folio whose description fails is dropped (not fatal) — same tolerance V1's
 * image path had; the doc proceeds with the folios that did describe. The whole
 * doc fails only if NO folio produced a description.
 */
import { PipelineStage, type StageDeps } from "../core/stage.js";
import type { RateGate, StageContext, StageOutcome } from "../core/types.js";
import { Semaphore } from "../core/semaphore.js";
import type { Describer } from "../ports.js";
import type { DocStateStore } from "../domain/doc-state.js";
import { keys } from "../domain/keys.js";
import { Q } from "../domain/queues.js";
import type { DocReady, PreparedDoc, PreparedPage } from "../domain/types.js";
import { failDoc } from "./doc-fail.js";

export class DescribeStage extends PipelineStage<DocReady, PreparedDoc> {
  readonly name = "describe";
  readonly inputQueue = Q.describe;
  override readonly outputQueue = Q.embed;
  override readonly concurrency: number;
  override readonly rate?: RateGate;

  /** Shared across all concurrently-processing docs: the total number of in-flight
   *  vision calls is capped here, so a single big doc fans its folios out wide
   *  while many docs still share one safe ceiling (OpenRouter rate/DDoS guard). */
  private readonly callGate: Semaphore;

  constructor(
    deps: StageDeps,
    private readonly describer: Describer,
    private readonly docState: DocStateStore,
    rate: RateGate | undefined,
    opts: { concurrency?: number; callConcurrency?: number } = {},
  ) {
    super(deps);
    this.rate = rate;
    this.concurrency = opts.concurrency ?? 4;
    this.callGate = new Semaphore(opts.callConcurrency ?? 24);
  }

  protected override async onExhausted(doc: DocReady, reason: string): Promise<void> {
    await this.docState.setStatus(doc.docJobId, "failed", {
      error: `describe_failed_after_retries: ${reason}`,
    });
  }

  async process(doc: DocReady, ctx: StageContext): Promise<StageOutcome<PreparedDoc>> {
    // Resume from the heavy artifact (the descriptions), NOT the base outcome
    // cache — the latter would replay a prior job's identity on a re-ingest. If
    // the pages are already in S3, skip the (paid/slow) Holo/Gemini calls and emit
    // a PreparedDoc built from THIS message's identity.
    const cachedPages = await this.blob.getJson<PreparedPage[]>(keys.pages(doc.ark));
    if (cachedPages && cachedPages.length > 0) {
      ctx.log.info("describe_cache_hit", { ark: doc.ark, pages: cachedPages.length });
      return { kind: "emit", items: [this.prepared(doc, cachedPages)] };
    }

    // Describe folios CONCURRENTLY, bounded by the shared callGate (so a 30-folio
    // doc fans out instead of crawling 1-at-a-time, without exceeding the vision
    // provider's safe concurrency). A failed folio is dropped (null), not fatal.
    const results = await Promise.all(
      doc.folios.map((ordre) =>
        this.callGate.run(async (): Promise<PreparedPage | null> => {
          const image = await this.blob.getBytes(keys.image(doc.ark, ordre));
          if (!image) return null;
          try {
            const text = await this.describer.describe({ ark: doc.ark, ordre, image, meta: doc.meta });
            return text.trim().length > 0 ? { ordre, text } : null;
          } catch (e) {
            ctx.log.warn("describe_folio_failed", {
              ark: doc.ark,
              ordre,
              error: e instanceof Error ? e.message : String(e),
            });
            return null;
          }
        }),
      ),
    );
    // Folios may finish out of order; restore folio order for citation accuracy.
    const pages: PreparedPage[] = results
      .filter((p): p is PreparedPage => p !== null)
      .sort((a, b) => a.ordre - b.ordre);

    if (pages.length === 0) {
      return failDoc(this.docState, doc.docJobId, "describe_no_pages");
    }
    await this.blob.putJson(keys.pages(doc.ark), pages);
    ctx.log.info("described", { ark: doc.ark, pages: pages.length });
    return { kind: "emit", items: [this.prepared(doc, pages)] };
  }

  private prepared(doc: DocReady, pages: PreparedPage[]): PreparedDoc {
    return {
      projectId: doc.projectId,
      docJobId: doc.docJobId,
      ark: doc.ark,
      lane: "vision",
      meta: doc.meta,
      pages,
    };
  }
}
