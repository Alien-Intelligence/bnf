/**
 * Test helper: the CURRENT claim of an ARK in a backfill store — the claim a
 * live delivery of the latest queued message would carry. An ARK with no row
 * gets generation 0 (no claim), so a mark on it still reaches the store's
 * "no row" error.
 */
import type { OcrBackfillClaim, OcrBackfillStore } from "../domain/ocr-backfill.js";

export async function claimOf(store: OcrBackfillStore, ark: string): Promise<OcrBackfillClaim> {
  const row = await store.get(ark);
  return { ark, generation: row === null ? 0 : row.generation };
}
