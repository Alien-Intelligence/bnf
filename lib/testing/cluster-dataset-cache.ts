// lib/testing/cluster-dataset-cache.ts
// An in-memory ClusterDatasetIdCache for tests that run the cluster runners
// without a database. `stored` is the cache's content: tests seed and read it.
import type { ClusterDatasetIdCache } from "@/lib/cluster/rag"

export type InMemoryClusterDatasetIdCache = ClusterDatasetIdCache & {
  /** Project id → stored dataset id, as written (so a test can seed a malformed value). */
  readonly stored: Map<string, string>
}

export function inMemoryClusterDatasetIdCache(): InMemoryClusterDatasetIdCache {
  const stored = new Map<string, string>()
  return {
    stored,
    read: async (projectId) => stored.get(projectId) ?? null,
    write: async (projectId, datasetId) => {
      stored.set(projectId, datasetId)
    },
  }
}
