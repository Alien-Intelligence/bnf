/**
 * Track 3 cluster sink — public surface.
 */
export { BnfClusterSink } from "./upsert.js";
export { ClusterClient } from "./client.js";
export { ClusterHttp, ClusterHttpError } from "./http.js";
export { bnfDatasetSchema, bnfDatasetSlug } from "./dataset.js";
export type { DatasetView, EntryView, IndexChunkInput } from "./client.js";

import { BnfClusterSink } from "./upsert.js";
import type { ClusterSink } from "../types.js";

export function getClusterSink(): ClusterSink {
  return new BnfClusterSink();
}

export default BnfClusterSink;
