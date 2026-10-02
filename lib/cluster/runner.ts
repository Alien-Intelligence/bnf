import "server-only"
// lib/cluster/runner.ts
// Facade that routes to the real ClusterClient or the FakeClusterRunner
// based on the CLUSTER_MODE env variable.
//
// CLUSTER_MODE=fake  (default) → FakeClusterRunner (in-process, no real HTTP)
// CLUSTER_MODE=real             → ClusterClient (real cluster API)
//
// All app code submits and cancels jobs through this facade; it never imports
// ClusterClient or FakeClusterRunner directly.
import type { WorkerOcrQualitySyncResponse } from "@/models/documents/types"
import type { ClusterIngestRequest, ClusterQueueProgress } from "./contracts"
import { ClusterClient } from "./client"
import { FakeClusterRunner } from "./fake"

export const ClusterRunner = {
  async submit(
    req: ClusterIngestRequest,
  ): Promise<{ clusterJobId: string }> {
    const mode = process.env.CLUSTER_MODE ?? "fake"
    return mode === "real"
      ? ClusterClient.submit(req)
      : FakeClusterRunner.submit(req)
  },

  /**
   * Live queue-status read-model for a run. Fake mode has no real pipeline to
   * report on (the FakeClusterRunner drives terminal progress directly), so it
   * returns null and the UI falls back to the reassurance banner.
   */
  async progress(
    clusterJobId: string,
  ): Promise<ClusterQueueProgress | null> {
    const mode = process.env.CLUSTER_MODE ?? "fake"
    return mode === "real" ? ClusterClient.progress(clusterJobId) : null
  },

  /**
   * Per-ARK OCR-quality artifacts (lib/documents/ocr-sync.ts). Real mode only:
   * the fake runner prepares no pages, so there is no artifact to sync. The
   * sync drainer is a no-op outside real mode; reaching this in fake mode is a
   * wiring bug and throws.
   */
  async ocrQualitySync(arks: string[]): Promise<WorkerOcrQualitySyncResponse> {
    const mode = process.env.CLUSTER_MODE ?? "fake"
    if (mode !== "real") {
      throw new Error(
        `ClusterRunner.ocrQualitySync: no worker in CLUSTER_MODE=${mode} — the OCR sync runs in real mode only`,
      )
    }
    return ClusterClient.ocrQualitySync(arks)
  },

  async cancel(clusterJobId: string): Promise<void> {
    const mode = process.env.CLUSTER_MODE ?? "fake"
    return mode === "real"
      ? ClusterClient.cancel(clusterJobId)
      : FakeClusterRunner.cancel(clusterJobId)
  },
}
