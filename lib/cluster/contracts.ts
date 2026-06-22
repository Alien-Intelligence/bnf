// lib/cluster/contracts.ts
// Pure types shared between this app and the cluster team.
// No runtime code — safe to import on both client and server.

export interface ClusterDoc {
  ark: string
  title: string
  year: number | null
  docType: string
  lang: string | null
  source: string
  iiifManifestUrl: string | null
}

export interface ClusterIngestRequest {
  projectId: string
  targetVersionId: string
  /**
   * The app-side IngestJob id. Carried explicitly on the wire so the cluster
   * worker does not need to parse it out of callbackUrl. Both sides of the
   * contract own this field.
   */
  appJobId: string
  added: ClusterDoc[]
  removed: string[]
  callbackUrl: string
  callbackSecret: string
}

export type ClusterProgressEvent =
  | {
      stage: "extract" | "chunk" | "embed" | "index"
      fraction: number
      counters: Record<string, number>
    }
  | { stage: "done"; chunksWritten: number; stats: Record<string, unknown> }
  | {
      stage: "failed"
      error: string
      partialStats?: Record<string, unknown>
    }
