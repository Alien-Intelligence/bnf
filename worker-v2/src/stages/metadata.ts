/**
 * Metadata stage — the head of the pipeline and the lane router.
 *
 *   DocRef → resolve BnfDocInfo → classify lane:
 *     text   → record plan (pagesExpected from the resolved info) + fan out N
 *              ALTO folio items to the ALTO fetch queue. Skips the manifest stage
 *              entirely (the manifest is already cached from resolution, but
 *              the text lane doesn't need the canvas list, only the count).
 *     vision → emit a ManifestReq (manifest stage will count pages + fan out images)
 *     mistral→ emit a ManifestReq
 *     skip   → setStatus skipped (no OCR + not an image, paid OCR off)
 *
 * Metadata resolution (resolveDocInfo/resolveManifest below) is the fix for the
 * 2026-08-11 rate-collapse incident (ai-memories/tech/repos/bnf/ingest-hardening,
 * F1/F2/F4/F6): the IIIF manifest is BOTH the primary metadata source AND the
 * canvas list image lanes need, but it lives behind a SEPARATE, scarcer quota
 * (40/min, vs. 1000/min for everything else). Before this fix, resolution called
 * an ungated client method that fetched the manifest itself — at
 * METADATA_CONCURRENCY (16) with zero rate gate, offered demand ran into the
 * thousands/min against a 40/min bucket, the broker's queue collapsed (p50 wait
 * 44s against a 45s worker timeout), and every image-lane doc fetched the SAME
 * manifest a second time in the manifest stage. Now: ONE manifest per ARK, ONE
 * shared RateLimiter instance gates both this stage and ManifestStage (wired in
 * build.ts as `rates.manifest`), and the cache (keys.manifest) is read/written by
 * whichever stage gets there first — S3 doesn't care which.
 *
 * Routes to two different queues by lane, so it sends explicitly via the queue and
 * returns `done` rather than using the base single-output `emit`. It does NOT use
 * the outcome cache (artifactKey=null): resolution is cheap on a cache hit and the
 * stage has side effects (recordPlan, fan-out) that must re-run idempotently on a
 * redelivery — folio duplicates are absorbed downstream (fetch S3 skip + Monitor
 * idempotent counter). The resolved metadata JSON is persisted to S3 for reuse.
 */
import { PipelineStage, type StageDeps } from "../core/stage.js";
import { acquireWithin, RateGateStoppedError } from "../core/rate.js";
import type { RateGate, StageContext, StageOutcome } from "../core/types.js";
import { classifyLane } from "../bnf/classify.js";
import { docInfoFromManifest } from "../bnf/client.js";
import {
  CorruptDocInfoError,
  inspectCachedDocInfo,
  isCachedManifest,
  unusableTauxOcr,
} from "../bnf/doc-info.js";
import type { BnfClient, BnfDocInfo, Manifest } from "../bnf/types.js";
import { PermanentBnfError } from "../bnf/errors.js";
import { ensureCanonicalArk, isCatalogueNotice, tauxOcrOf, type OcrRateParse } from "../bnf/parse.js";
import type { DocStateStore } from "../domain/doc-state.js";
import { keys } from "../domain/keys.js";
import { Q, sendFolios } from "../domain/queues.js";
import type { DocMeta, DocRef, FolioItem, ManifestReq } from "../domain/types.js";


/** Why the metadata stage skips a document — the doc's recorded skipReason. */
export const METADATA_SKIP_REASON = {
  NOT_DIGITIZED: "not_digitized",
  METADATA_UNAVAILABLE: "metadata_unavailable",
  /** BnF publishes no page count for a text doc: unknown, not empty. */
  PAGE_COUNT_UNKNOWN: "page_count_unknown",
  /** BnF publishes a page count of zero. */
  NO_PAGES: "no_pages",
} as const;

export interface MetadataOpts {
  /** Paid Mistral OCR enabled → sans_texte text docs route to the mistral lane. */
  mistralEnabled: boolean;
  /** Cap on folios per doc (matches V1 maxOcrPages, default 200). */
  maxPages?: number;
  /**
   * Cap on canvases read from a fetched/cached manifest. MUST equal
   * ManifestStage's own `maxCanvases` (both are wired from the SAME
   * `cfg.maxCanvases` in build.ts) — the two stages read and write the exact
   * same blob under keys.manifest(ark), so a mismatched cap would make the
   * cached shape depend on which stage got there first. Default 200 (matches
   * ManifestStage's class default).
   */
  maxCanvases?: number;
  /** Doc-resolution concurrency. On a manifest-cache MISS this is bounded by the
   *  shared manifest rate gate (BNF_RATES.manifest.rpm), not this — so this just needs
   *  to be high enough to keep that rate fed once cache hits dominate. Default 6. */
  concurrency?: number;
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
  override readonly concurrency: number;
  // 30s base delay — see the field's doc comment on PipelineStage (core/stage.ts)
  // for why: BnF's manifest quota resets on fixed clock-minute windows, so
  // pg-boss's default 5s ladder just re-hits the still-closed window (F6).
  override readonly queueRetryDelayMs = 30_000;
  // 600s. Worst case for ONE delivery: a manifest-cache miss waits on the shared
  // manifest gate (up to a clock-minute window), then a 135s manifest fetch
  // (BNF_PAGE_TIMEOUT_MS, deliberately above the broker's 120s), and if that comes
  // back permanent, a 45s OAI fallback (BNF_META_TIMEOUT_MS) — plus S3 round trips
  // and margin. This is the stage whose expiration wedged prod run efe5d747; it is
  // now chosen, not inherited (see PipelineStage.expireInSeconds).
  override readonly expireInSeconds = 600;

  private readonly mistralEnabled: boolean;
  private readonly maxPages: number;
  private readonly maxCanvases: number;

  constructor(
    deps: StageDeps,
    private readonly bnf: BnfClient,
    private readonly docState: DocStateStore,
    /** The shared manifest RateGate — the SAME instance ManifestStage holds
     *  (build.ts wires `rates.manifest` into both). Only acquired on a manifest
     *  cache MISS (see resolveManifest) — a metadata- or manifest-cache HIT costs
     *  zero tokens, which is what keeps this stage from starving ManifestStage's
     *  fan-out under the shared manifest budget. */
    private readonly manifestRate: RateGate | undefined,
    opts: MetadataOpts,
  ) {
    super(deps);
    this.mistralEnabled = opts.mistralEnabled;
    this.maxPages = opts.maxPages ?? 200;
    this.maxCanvases = opts.maxCanvases ?? 200;
    this.concurrency = opts.concurrency ?? 6;
  }

  async process(doc: DocRef, ctx: StageContext): Promise<StageOutcome<never>> {
    await this.docState.upsertDoc(doc);

    let info: BnfDocInfo;
    try {
      // The metadata blob cache is the OUTERMOST cache — a hit here means zero
      // work at all (no manifest cache lookup, no gate acquire, no BnF call).
      // Read through the normalizer: a pre-release blob lacks `ocrRate`, which
      // is derived from its cached manifest metadata (bnf/doc-info.ts, D5).
      const cached = await this.readCachedDocInfo(doc.ark, ctx);
      info = cached ?? (await this.resolveDocInfo(doc.ark, ctx));
      if (!cached) await this.blob.putJson(keys.metadata(doc.ark), info);
    } catch (e) {
      // A stopped gate (shutdown) is handed back by the stage base — never a doc failure.
      if (e instanceof RateGateStoppedError) throw e;
      if (e instanceof PermanentBnfError) {
        const reason =
          e.cause === METADATA_SKIP_REASON.NOT_DIGITIZED
            ? METADATA_SKIP_REASON.NOT_DIGITIZED
            : METADATA_SKIP_REASON.METADATA_UNAVAILABLE;
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
      // An unknown count is not an empty document: say which one it is rather
      // than defaulting null to 0 and reporting "no pages".
      if (info.pageCount === null) {
        const reason = METADATA_SKIP_REASON.PAGE_COUNT_UNKNOWN;
        await this.docState.setStatus(doc.docJobId, "skipped", { skipReason: reason });
        return { kind: "skip", reason };
      }
      const pageCount = info.pageCount;
      if (pageCount <= 0) {
        const reason = METADATA_SKIP_REASON.NO_PAGES;
        await this.docState.setStatus(doc.docJobId, "skipped", { skipReason: reason });
        return { kind: "skip", reason };
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
      await sendFolios(this.queue, folios);
      ctx.log.info("metadata_text_fanout", { ark: doc.ark, folios: pages });
      return { kind: "done" };
    }

    // image lanes → hand off to the manifest stage (it knows the page count).
    const req: ManifestReq = { ...doc, lane: decision.lane, meta };
    await this.queue.send(Q.manifest, req);
    ctx.log.info("metadata_manifest_handoff", { ark: doc.ark, lane: decision.lane });
    return { kind: "done" };
  }

  /**
   * The cached doc-info, or null on a miss. A corrupt blob (CorruptDocInfoError)
   * is logged and treated as a miss: process() resolves it again from BnF and
   * overwrites it, instead of retrying a blob that will never parse and then
   * failing the doc as "metadata unavailable".
   */
  private async readCachedDocInfo(ark: string, ctx: StageContext): Promise<BnfDocInfo | null> {
    const rawCached = await this.blob.getJson<unknown>(keys.metadata(ark));
    if (rawCached === null) return null;
    try {
      const cached = inspectCachedDocInfo(rawCached);
      if (cached.unusableTauxOcr !== null) {
        ctx.log.warn("taux_ocr_unusable", { ark, origin: "legacy_cache", ...cached.unusableTauxOcr });
      }
      return cached.info;
    } catch (e) {
      if (!(e instanceof CorruptDocInfoError)) throw e;
      ctx.log.warn("metadata_cache_corrupt", { ark, key: keys.metadata(ark), error: e.message });
      return null;
    }
  }

  /**
   * Resolve BnfDocInfo on a metadata-cache MISS. The IIIF manifest is the
   * PRIMARY path (see docInfoFromManifest's header for why); OAI-PMH is the
   * fallback for the rare permanently-manifest-less ARK. Transient errors from
   * either path propagate to process()'s catch, which retries/exhausts exactly
   * like every other stage.
   */
  private async resolveDocInfo(ark: string, ctx: StageContext): Promise<BnfDocInfo> {
    const canonicalArk = ensureCanonicalArk(ark);
    // Fail fast on catalogue notices. `cb*` ARKs are bibliographic/authority
    // records, not digitized documents — they have no pages, so every fetch
    // ECONNRESETs. The prefix is deterministic → a permanent classification
    // (NOT a generic "network error → permanent" rule; real throttling on a
    // digitized ARK must still retry). Ported verbatim from the client's old
    // getDocumentInfo — same check, same place in the flow, just moved here now
    // that this stage owns metadata resolution.
    if (isCatalogueNotice(canonicalArk)) {
      throw new PermanentBnfError(METADATA_SKIP_REASON.NOT_DIGITIZED, {
        hint: `${canonicalArk}: catalogue notice (cb*), not a digitized document`,
      });
    }
    try {
      const manifest = await this.resolveManifest(canonicalArk, ctx.signal);
      // The ONE Taux OCR lookup of this manifest: logged here if unusable,
      // then handed to docInfoFromManifest — never parsed twice.
      const tauxOcr = tauxOcrOf(manifest.metadata);
      logUnusableTauxOcr(ctx, canonicalArk, tauxOcr);
      return docInfoFromManifest(manifest, canonicalArk, tauxOcr, this.bnf.manifestUrl(canonicalArk));
    } catch (e) {
      // A permanently-unavailable manifest is rare (every digitized doc has one)
      // but possible for a few legacy/edge ARKs. Fall back to OAI so those still
      // resolve rather than being dropped. Transient errors propagate as-is.
      if (e instanceof PermanentBnfError) {
        return await this.bnf.getDocumentInfoViaOai(canonicalArk);
      }
      throw e;
    }
  }

  /**
   * The manifest blob cache (shared with ManifestStage, keys.manifest(ark)) +
   * the ONE shared rate gate. A hit costs nothing; a miss acquires exactly one
   * token and makes exactly one getManifest call, then populates the cache —
   * so whichever stage (this one or ManifestStage) needs the manifest next
   * finds it already there. This is the F1/F2 fix made concrete: one fetch per
   * ARK, gated once, no matter how many stages end up wanting the manifest.
   */
  private async resolveManifest(canonicalArk: string, signal: AbortSignal): Promise<Manifest> {
    const cached = await this.blob.getJson<unknown>(keys.manifest(canonicalArk));
    if (cached !== null) {
      if (isCachedManifest(cached)) return cached;
      // Corrupt: repaired below from BnF (and overwritten), like a corrupt doc-info.
      this.log.warn("manifest_cache_corrupt", { ark: canonicalArk, key: keys.manifest(canonicalArk) });
    }
    if (this.manifestRate) await acquireWithin(this.manifestRate, this.rateWaitMs, signal);
    const manifest = await this.bnf.getManifest(canonicalArk, this.maxCanvases);
    await this.blob.putJson(keys.manifest(canonicalArk), manifest);
    return manifest;
  }
}

/**
 * Log a "Taux OCR" row BnF published but we cannot read (unparseable or out of
 * range): docInfoFromManifest records it as `ocrRate: null`, which on its own
 * is indistinguishable from "no OCR row". This is where the value first enters
 * the worker (a fresh manifest), so it is the one place it is logged.
 */
function logUnusableTauxOcr(ctx: StageContext, ark: string, parsed: OcrRateParse): void {
  const unusable = unusableTauxOcr(parsed);
  if (unusable !== null) {
    ctx.log.warn("taux_ocr_unusable", { ark, origin: "manifest", ...unusable });
  }
}

