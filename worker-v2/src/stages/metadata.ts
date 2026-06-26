/**
 * Metadata stage — the head of the pipeline and the lane router.
 *
 *   DocRef → OAI getDocumentInfo → classify lane:
 *     text   → record plan (pagesExpected from OAI) + fan out N ALTO folio items
 *              to the fetch queue. Skips the 42/min manifest stage entirely.
 *     vision → emit a ManifestReq (manifest stage will count pages + fan out images)
 *     mistral→ emit a ManifestReq
 *     skip   → setStatus skipped (no OCR + not an image, paid OCR off)
 *
 * Routes to two different queues by lane, so it sends explicitly via the queue and
 * returns `done` rather than using the base single-output `emit`. It does NOT use
 * the outcome cache (artifactKey=null): the OAI call is cheap/ungated and the
 * stage has side effects (recordPlan, fan-out) that must re-run idempotently on a
 * redelivery — folio duplicates are absorbed downstream (fetch S3 skip + Monitor
 * idempotent counter). The resolved metadata JSON is persisted to S3 for reuse.
 */
import { PipelineStage, type StageDeps } from "../core/stage.js";
import type { StageContext, StageOutcome } from "../core/types.js";
import { classifyLane } from "../bnf/classify.js";
import type { BnfClient, BnfDocInfo } from "../bnf/types.js";
import { PermanentBnfError } from "../bnf/errors.js";
import type { DocStateStore } from "../domain/doc-state.js";
import { keys } from "../domain/keys.js";
import { FETCH_PRIORITY, Q } from "../domain/queues.js";
import type { DocMeta, DocRef, FolioItem, ManifestReq } from "../domain/types.js";

export interface MetadataOpts {
  /** Paid Mistral OCR enabled → sans_texte text docs route to the mistral lane. */
  mistralEnabled: boolean;
  /** Cap on folios per doc (matches V1 maxOcrPages, default 200). */
  maxPages?: number;
}

function toMeta(info: BnfDocInfo): DocMeta {
  return {
    title: info.title,
    creator: info.creator,
    date: info.date,
    docType: info.docType,
    subtype: info.subtype,
    lang: info.lang,
    pageCount: info.pageCount,
    ocrAvailable: info.ocrAvailable,
  };
}

export class MetadataStage extends PipelineStage<DocRef, never> {
  readonly name = "metadata";
  readonly inputQueue = Q.metadata;
  override readonly concurrency = 6;

  private readonly mistralEnabled: boolean;
  private readonly maxPages: number;

  constructor(
    deps: StageDeps,
    private readonly bnf: BnfClient,
    private readonly docState: DocStateStore,
    opts: MetadataOpts,
  ) {
    super(deps);
    this.mistralEnabled = opts.mistralEnabled;
    this.maxPages = opts.maxPages ?? 200;
  }

  async process(doc: DocRef, ctx: StageContext): Promise<StageOutcome<never>> {
    await this.docState.upsertDoc(doc);

    let info: BnfDocInfo;
    try {
      const cached = await this.blob.getJson<BnfDocInfo>(keys.metadata(doc.ark));
      info = cached ?? (await this.bnf.getDocumentInfo(doc.ark));
      if (!cached) await this.blob.putJson(keys.metadata(doc.ark), info);
    } catch (e) {
      if (e instanceof PermanentBnfError) {
        const reason = e.cause === "not_digitized" ? "not_digitized" : "metadata_unavailable";
        await this.docState.setStatus(doc.docJobId, "skipped", { skipReason: reason });
        return { kind: "skip", reason };
      }
      // Transient: retry while attempts remain; on the LAST attempt mark the doc
      // failed so it reaches a terminal state instead of orphaning in 'queued'
      // when pg-boss exhausts the job's retries (same idiom as fetch/manifest).
      if (ctx.attempt >= this.retry.attempts) {
        const reason = `metadata_unavailable_after_retries: ${e instanceof Error ? e.message : String(e)}`;
        await this.docState.setStatus(doc.docJobId, "failed", { error: reason });
        return { kind: "fail", reason, terminal: true };
      }
      throw e;
    }

    const meta = toMeta(info);
    const decision = classifyLane(info, { mistralEnabled: this.mistralEnabled });
    if (decision.kind === "skip") {
      await this.docState.setStatus(doc.docJobId, "skipped", { skipReason: decision.reason });
      return { kind: "skip", reason: decision.reason };
    }

    if (decision.lane === "text") {
      const pageCount = info.pageCount ?? 0;
      if (pageCount <= 0) {
        await this.docState.setStatus(doc.docJobId, "skipped", { skipReason: "no_pages" });
        return { kind: "skip", reason: "no_pages" };
      }
      const pages = Math.min(pageCount, this.maxPages);
      await this.docState.recordPlan(doc.docJobId, { lane: "text", pagesExpected: pages, meta });
      const folios: FolioItem[] = Array.from({ length: pages }, (_, i) => ({
        docJobId: doc.docJobId,
        ark: doc.ark,
        ordre: i + 1,
        kind: "alto",
        lane: "text",
      }));
      await this.queue.sendMany(Q.fetch, withPriority(folios));
      ctx.log.info("metadata_text_fanout", { ark: doc.ark, folios: pages });
      return { kind: "done" };
    }

    // image lanes → hand off to the manifest stage (it knows the page count).
    const req: ManifestReq = { ...doc, lane: decision.lane, meta };
    await this.queue.send(Q.manifest, req);
    ctx.log.info("metadata_manifest_handoff", { ark: doc.ark, lane: decision.lane });
    return { kind: "done" };
  }
}

/** pg-boss reads `priority` off the payload at send-time; memory queue ignores it.
 *  Stamped so the fetch queue drains tail-first (mistral images > vision > alto). */
function withPriority(items: FolioItem[]): Array<FolioItem & { priority: number }> {
  return items.map((it) => ({ ...it, priority: FETCH_PRIORITY[it.lane] }));
}
