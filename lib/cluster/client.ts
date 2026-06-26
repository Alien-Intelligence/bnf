import "server-only"
// lib/cluster/client.ts
// Real-mode cluster client — invokes the cluster worker's HTTP ingest API.
//
// Environment:
//   WORKER_RUNNER_URL          — base URL of the cluster worker HTTP API
//                                (e.g. http://localhost:7777). REQUIRED in real mode.
//   WORKER_RUNNER_TIMEOUT_MS   — per-request timeout in ms (default 30000).
//
// On any non-2xx response or transport error, throws an Error with enough
// context for IngestService.submit to mark the parent job failed.
import type { ClusterIngestRequest, ClusterQueueProgress } from "./contracts"

const DEFAULT_TIMEOUT_MS = 30_000

function workerUrl(): string {
  const url = process.env.WORKER_RUNNER_URL
  if (!url || url.trim().length === 0) {
    throw new Error(
      "ClusterClient: WORKER_RUNNER_URL is not set. Set CLUSTER_MODE=fake or provide WORKER_RUNNER_URL.",
    )
  }
  return url.replace(/\/+$/, "")
}

function timeoutMs(): number {
  const raw = process.env.WORKER_RUNNER_TIMEOUT_MS
  if (!raw) return DEFAULT_TIMEOUT_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS
  return n
}

async function postJson(path: string, body: unknown): Promise<Response> {
  const base = workerUrl()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs())
  try {
    return await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `ClusterClient: request to ${base}${path} timed out after ${timeoutMs()}ms`,
      )
    }
    throw new Error(
      `ClusterClient: request to ${base}${path} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  } finally {
    clearTimeout(timer)
  }
}

export class ClusterClient {
  static async submit(
    req: ClusterIngestRequest,
  ): Promise<{ clusterJobId: string }> {
    const res = await postJson("/ingest", req)
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(
        `ClusterClient.submit: worker returned ${res.status} ${res.statusText}: ${text}`,
      )
    }
    const json = (await res.json().catch(() => null)) as
      | { clusterJobId?: unknown }
      | null
    if (!json || typeof json.clusterJobId !== "string") {
      throw new Error(
        "ClusterClient.submit: worker response missing clusterJobId",
      )
    }
    return { clusterJobId: json.clusterJobId }
  }

  /**
   * Fetch the worker's live queue-status read-model for a run. Best-effort: this
   * drives the Ingérer live view, NOT the version commit (that rides the terminal
   * callback). A 404 (run unknown / already pruned) or any transport error
   * resolves to null so the page degrades to the reassurance banner rather than
   * erroring — the commit path is unaffected.
   */
  static async progress(
    clusterJobId: string,
  ): Promise<ClusterQueueProgress | null> {
    const base = workerUrl()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs())
    try {
      const res = await fetch(
        `${base}/progress/${encodeURIComponent(clusterJobId)}`,
        { signal: controller.signal },
      )
      if (!res.ok) return null
      return (await res.json()) as ClusterQueueProgress
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  static async cancel(clusterJobId: string): Promise<void> {
    const res = await postJson(
      `/ingest/${encodeURIComponent(clusterJobId)}/cancel`,
      {},
    )
    if (!res.ok && res.status !== 404) {
      // 404 is acceptable: the job may have already terminated or never existed.
      const text = await res.text().catch(() => "")
      throw new Error(
        `ClusterClient.cancel: worker returned ${res.status} ${res.statusText}: ${text}`,
      )
    }
  }
}
