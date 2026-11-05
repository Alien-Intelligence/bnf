// lib/agent/tools/cluster-dataset-cache.ts
// The cluster dataset-id cache the agent tools hand to lib/cluster: the
// project's resolved composite dataset id, remembered on
// `Project.clusterDatasetId`. lib/cluster never imports models/ (playbook
// api-layers.md, models.md), so this entry-point layer wires the model's read
// and write into the port the runners take (ClusterDatasetIdCache) — the same
// shape as note.ts wiring `LowOcrFoliosLookup` into the quote check.
import "server-only"

import type { ClusterDatasetIdCache } from "@/lib/cluster/rag"
import { ProjectQueries } from "@/models/projects/queries"
import { ProjectService } from "@/models/projects/service"

/** The one cache over `Project.clusterDatasetId`; stateless, so a single instance serves every turn. */
export const projectClusterDatasetIdCache: ClusterDatasetIdCache = {
  read: (projectId) => ProjectQueries.clusterDatasetId(projectId),
  write: (projectId, datasetId) => ProjectService.setClusterDatasetId(projectId, datasetId),
}
