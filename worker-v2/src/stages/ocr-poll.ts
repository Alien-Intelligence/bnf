/**
 * OCR poll stage — mistral lane, step 2 of 2. A cheap poller: check the batch's
 * status; while it's pending, re-enqueue the pointer to itself (with a delay in
 * prod via the queue's startAfter; the memory queue re-delivers immediately) so
 * the wait costs a queue row, not a worker slot. On completion, fetch the
 * folio-aligned OCR pages, persist them, and emit a PreparedDoc to embedding.
 *
 * Does NOT use the base outcome cache: the pending path's effect is a self
 * re-enqueue, which a cached `done` re-dispatch would silently drop (polling would
 * stall). Idempotency comes from the downstream embed stage's artifact cache.
 * `maxPolls` bounds a stuck batch → terminal `ocr_timeout` (no unbounded loop).
 *
 * F13/F14/F15 honesty + recovery pass
 * (ai-memories/tech/repos/bnf/ingest-hardening): "done" no longer means
 * "trustworthy" — `pollBatch` now reports drop/error counts alongside a
 * SUCCESS batch's pages, and reports a non-SUCCESS terminal batch as `failed`
 * even with a partial output attached. This stage turns that into an honest
 * doc outcome:
 *   - zero surviving pages → the doc fails with a reason naming the real
 *     cause (never the old lying `ocr_no_text` — there WAS text, it was
 *     garbage).
 *   - ≥1 surviving page → the doc still proceeds (partial by design, per Leo:
 *     no abort threshold), but the loss is RECORDED (`recordPageDrops`)
 *     instead of silently vanishing (the "32 done docs mostly hollow" bug).
 *
 * Un-poison invariant (F15): `keys.ocrBatch(ark)` is a PAID-dedupe handle
 * (ocr-submit.ts refuses to pay twice while it exists). A batch that will
 * NEVER produce a usable result for this ARK — a `failed` poll state, or a
 * SUCCESS with zero surviving pages — must delete that handle, or a future
 * re-ingest of this ARK re-polls the exact same dead batch and fails
 * identically forever. A batch that is merely still pending, or that produced
 * ≥1 usable page, keeps its handle (it is not dead).
 */
import { PipelineStage, type StageDeps } from "../core/stage.js";
import type { StageContext, StageOutcome } from "../core/types.js";
import type { OcrEngine } from "../ports.js";
import type { DocStateStore } from "../domain/doc-state.js";
import { keys } from "../domain/keys.js";
import { Q } from "../domain/queues.js";
import type { OcrBatchRef, PreparedDoc } from "../domain/types.js";
import { failDoc } from "./doc-fail.js";

export interface OcrPollOpts {
  /** Cap on poll iterations before declaring the batch stuck (terminal). */
  maxPolls?: number;
  /** Delay between polls (ms) — pg-boss startAfter; memory queue ignores it. */
  pollDelayMs?: number;
  /** In-flight poll concurrency (cheap GETs). */
  concurrency?: number;
}

/**
 * Short French cause phrase for a drop tally — used both in the (English-coded)
 * terminal-fail reason for zero survivors and in the app-facing warning text
 * for partial survivors (buildTerminalEvent composes the latter from
 * DocRow.dropReason, which is exactly this string).
 */
function describeDropCause(
  dropped: { empty: number; hallucinated: number },
  entryErrorCount: number,
): string {
  const causes: string[] = [];
  if (dropped.hallucinated > 0) causes.push("hallucination détectée");
  if (dropped.empty > 0) causes.push("pages vides");
  if (entryErrorCount > 0) causes.push("erreurs de transcription");
  return causes.length > 0 ? causes.join(", ") : "cause inconnue";
}

export class OcrPollStage extends PipelineStage<OcrBatchRef, PreparedDoc> {
  readonly name = "ocr-poll";
  readonly inputQueue = Q.ocrPoll;
  override readonly outputQueue = Q.embed;
  override readonly concurrency: number;

  private readonly maxPolls: number;
  private readonly pollDelayMs: number;

  constructor(
    deps: StageDeps,
    private readonly ocr: OcrEngine,
    private readonly docState: DocStateStore,
    opts: OcrPollOpts = {},
  ) {
    super(deps);
    this.maxPolls = opts.maxPolls ?? 240; // ~ default poll cap (tune per pollDelayMs)
    this.pollDelayMs = opts.pollDelayMs ?? 15_000;
    this.concurrency = opts.concurrency ?? 8;
  }

  protected override async onExhausted(ref: OcrBatchRef, reason: string): Promise<void> {
    await this.docState.setStatus(ref.docJobId, "failed", {
      error: `ocr_poll_failed_after_retries: ${reason}`,
    });
  }

  async process(ref: OcrBatchRef, ctx: StageContext): Promise<StageOutcome<PreparedDoc>> {
    const status = await this.ocr.pollBatch(ref.batchId);

    if (status.state === "failed") {
      // Un-poison (F15): a batch that ended non-SUCCESS will NEVER produce a
      // usable result for this ARK. Delete the handle BEFORE failing the doc —
      // if the process dies between the two, the worst case is a failed doc
      // with no handle (a re-ingest resubmits cleanly), never the inverse (a
      // dead handle outliving the doc it poisoned).
      await this.blob.delete(keys.ocrBatch(ref.ark));
      return failDoc(this.docState, ref.docJobId, `ocr_batch_failed: ${status.reason}`);
    }

    if (status.state === "pending") {
      const attempt = (ref.pollAttempt ?? 0) + 1;
      if (attempt > this.maxPolls) {
        // Our own poll ceiling, not a provider-terminal state — the batch may
        // still be genuinely in flight at Mistral. The handle stays: deleting
        // it here could double-pay if the batch later succeeds and a re-ingest
        // resubmits in the meantime.
        ctx.log.warn("ocr_poll_timeout", { ark: ref.ark, batchId: ref.batchId, attempt });
        return failDoc(this.docState, ref.docJobId, "ocr_timeout");
      }
      await this.queue.send(
        Q.ocrPoll,
        { ...ref, pollAttempt: attempt },
        { startAfterMs: this.pollDelayMs },
      );
      return { kind: "done" }; // this delivery is consumed; the re-enqueue carries on
    }

    // done — SUCCESS, but honestly parsed (F14): dropped/errored entries are
    // counted, never silently absorbed.
    const { pages, dropped, entryErrors } = status;
    const expected = ref.folios.length;
    const lostCount = dropped.empty + dropped.hallucinated + entryErrors.length;

    if (pages.length === 0) {
      const cause = describeDropCause(dropped, entryErrors.length);
      ctx.log.warn("ocr_all_pages_dropped", {
        ark: ref.ark,
        batchId: ref.batchId,
        expected,
        dropped,
        entryErrors: entryErrors.length,
      });
      // Un-poison (F15): zero usable pages is a TERMINAL outcome for this
      // batch — delete the handle so a re-ingest of this ARK resubmits a
      // FRESH batch instead of re-polling this same all-garbage one forever.
      await this.blob.delete(keys.ocrBatch(ref.ark));
      return failDoc(
        this.docState,
        ref.docJobId,
        `ocr_pages_dropped: 0/${expected} usable (${cause})`,
      );
    }

    if (lostCount > 0) {
      // Partial by design (per Leo: no abort threshold) — the doc PROCEEDS,
      // but the loss is recorded so it surfaces to the librarian instead of
      // silently shipping a hollow RAG entry (F13).
      await this.docState.recordPageDrops(ref.docJobId, {
        dropped: lostCount,
        expected,
        reason: describeDropCause(dropped, entryErrors.length),
      });
      ctx.log.warn("ocr_partial_pages_dropped", {
        ark: ref.ark,
        batchId: ref.batchId,
        expected,
        survived: pages.length,
        lost: lostCount,
      });
    }

    await this.blob.putJson(keys.pages(ref.ark), pages);
    ctx.log.info("ocr_done", {
      ark: ref.ark,
      batchId: ref.batchId,
      pages: pages.length,
      lost: lostCount,
    });
    const prepared: PreparedDoc = {
      projectId: ref.projectId,
      docJobId: ref.docJobId,
      ark: ref.ark,
      lane: "mistral",
      meta: ref.meta,
      pages,
    };
    return { kind: "emit", items: [prepared] };
  }
}
