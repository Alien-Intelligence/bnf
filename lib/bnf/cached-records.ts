// lib/bnf/cached-records.ts
// Pure reading of BnF record cache rows (models/bnf-records), for the callers
// that read the cache through BnfRecordQueries (the background drainers).
// Imports no server-only module.

import type { BnfMcpDocumentDetail } from "@/lib/bnf/types"
import type { BnfRecordRow } from "@/models/bnf-records/schema"

function isRecordObject(payload: unknown): payload is BnfMcpDocumentDetail {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
}

/**
 * The records held in `rows`, keyed by ARK. A row whose payload is not a JSON
 * object is corrupt: it is reported through `onCorrupt` and left out, so the
 * caller treats it as a miss, fetches the record again, and its write repairs
 * the entry.
 */
export function recordsFromCacheRows(
  rows: readonly BnfRecordRow[],
  onCorrupt: (ark: string) => void,
): Map<string, BnfMcpDocumentDetail> {
  const found = new Map<string, BnfMcpDocumentDetail>()
  for (const row of rows) {
    if (!isRecordObject(row.payload)) {
      onCorrupt(row.ark)
      continue
    }
    found.set(row.ark, row.payload)
  }
  return found
}
