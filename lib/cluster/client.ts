import "server-only"
// lib/cluster/client.ts
// Real-mode cluster client — invokes the cluster worker's HTTP ingest API.
//
// Environment:
//   WORKER_RUNNER_URL          — base URL of the cluster worker HTTP API
//                                (e.g. http://localhost:7777). REQUIRED in real mode.
//   WORKER_RUNNER_TIMEOUT_MS   — per-request timeout in ms (default 30000 when
//                                unset; a set but invalid value throws).
//
// On any non-2xx response or transport error, throws an Error with enough
// context for IngestService.submit to mark the parent job failed.
import { z } from "zod"

import {
  workerOcrQualitySyncResponseSchema,
  type WorkerOcrQualitySyncResponse,
} from "@/models/documents/types"
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

/**
 * WORKER_RUNNER_TIMEOUT_MS → ms. Unset or blank is the documented default; a
 * value that is set but is not a positive integer throws (found bug B6): a typo
 * such as "30s" used to fall back to the default in silence. Exported for the
 * tests (lib/cluster/client.test.ts).
 */
export function parseWorkerTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_MS
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(
      `WORKER_RUNNER_TIMEOUT_MS must be a positive integer number of milliseconds, got "${raw}"`,
    )
  }
  return n
}

function timeoutMs(): number {
  return parseWorkerTimeoutMs(process.env.WORKER_RUNNER_TIMEOUT_MS)
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

  /**
   * POST /ocr-quality/sync — the per-ARK OCR-quality artifacts for `arks`
   * (lib/documents/ocr-sync.ts, plan D7). The worker returns the artifacts it
   * has and queues a rate-gated build for the others. A non-2xx throws with the
   * body; a body that is not a valid sync response throws with the Zod issues —
   * a contract break is never written to the app DB.
   */
  static async ocrQualitySync(arks: string[]): Promise<WorkerOcrQualitySyncResponse> {
    const res = await postJson("/ocr-quality/sync", { arks })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        `ClusterClient.ocrQualitySync: worker returned ${res.status} ${res.statusText}: ${text}`,
      )
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (err) {
      throw new Error(
        `ClusterClient.ocrQualitySync: worker response is not JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    const parsed = workerOcrQualitySyncResponseSchema.safeParse(json)
    if (!parsed.success) {
      throw new Error(
        `ClusterClient.ocrQualitySync: invalid worker response: ${z.prettifyError(parsed.error)}`,
      )
    }
    return parsed.data
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
