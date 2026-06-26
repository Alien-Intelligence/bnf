/**
 * Shared terminal-fail helper for the back-half lane stages (assemble, describe,
 * ocr-submit/poll, embed). When one of these terminates a doc, the doc-state row
 * must flip to `failed` so the observability read-model counts it — otherwise a
 * doc the Monitor already marked `ready` would sit there forever and the
 * done/failed/skipped invariant would silently under-report failures (exactly the
 * blind spot V1 had). The fail variant carries no `Out`, so it satisfies any
 * StageOutcome<Out>.
 */
import type { StageOutcome } from "../core/types.js";
import type { DocStateStore } from "../domain/doc-state.js";

export async function failDoc(
  docState: DocStateStore,
  docJobId: string,
  reason: string,
): Promise<StageOutcome<never>> {
  await docState.setStatus(docJobId, "failed", { error: reason });
  return { kind: "fail", reason, terminal: true };
}
