import "server-only"
// lib/cluster/client.ts
// Real-mode cluster client — invokes the cluster's HTTP ingest API.
// Currently a stub: the cluster API isn't built yet.
// Set CLUSTER_MODE=real once the real cluster endpoints are available.
import type { ClusterIngestRequest } from "./contracts"

export class ClusterClient {
  static async submit(
    _req: ClusterIngestRequest,
  ): Promise<{ clusterJobId: string }> {
    throw new Error(
      "ClusterClient (real mode) not yet implemented — set CLUSTER_MODE=fake.",
    )
  }

  static async cancel(_clusterJobId: string): Promise<void> {
    throw new Error(
      "ClusterClient (real mode) not yet implemented — set CLUSTER_MODE=fake.",
    )
  }
}
