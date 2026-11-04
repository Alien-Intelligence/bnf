// lib/cluster/composite-ids.ts
// The data-cluster MCP's ids (mcp-data-cluster ≥ 0.3.0, SDS-1031).
//
// Every id the MCP speaks is a composite string of PLATFORM ids, not the
// cluster-local integers the data-cluster REST API (and worker-v2) use:
//
//   dataset  "cluster:dataset"        e.g. "113:6363"
//   entry    "cluster:dataset:entry"  e.g. "113:6363:9195583"
//
// The MCP returns them in `dataset_id` / `entry_id` and accepts them back, byte
// for byte, in `dataset_id`, `entry_id`, `dataset_ids` and `entry_ids`; an
// integer id is refused. They are opaque handles: the app passes them back
// untouched and only breaks a creation-time tie between two entries of one
// dataset with the entry number (entryOrdinal). Branded so a free string — or a
// number left over from the old contract — cannot be passed where an id is
// required.

import { z } from "zod"

export const datasetIdSchema = z
  .string()
  .regex(/^\d+:\d+$/, 'a dataset id is "cluster:dataset" (e.g. "113:6363")')
  .brand<"DatasetId">()
export type DatasetId = z.infer<typeof datasetIdSchema>

export const entryIdSchema = z
  .string()
  .regex(/^\d+:\d+:\d+$/, 'an entry id is "cluster:dataset:entry" (e.g. "113:6363:9195583")')
  .brand<"EntryId">()
export type EntryId = z.infer<typeof entryIdSchema>

/**
 * The platform entry number inside an entry id. It is NOT a creation order —
 * the backend's batch sync assigns platform ids by version, not by the order
 * the cluster created the entries — so it never decides which entry is newer
 * (that is the entry's `created_at`, rag-wire.ts pickLiveEntryId); it only
 * makes the choice deterministic when two entries share a creation time. Only
 * comparable between entries of the SAME dataset. BigInt, because the id is a
 * string of any length.
 */
export function entryOrdinal(id: EntryId): bigint {
  return BigInt(id.slice(id.lastIndexOf(":") + 1))
}
