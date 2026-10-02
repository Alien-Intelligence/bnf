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
// Every worker call — request AND response body — is bounded by
// WORKER_RUNNER_TIMEOUT_MS: the body is read before the deadline is cleared.
// On any non-2xx response or transport error, throws an Error with enough
// context for IngestService.submit to mark the parent job failed; the
// OCR-quality sync throws the typed OcrSyncUnavailableError /
// OcrSyncContractError (lib/cluster/ocr-quality.ts) the drainer acts on.
import { z } from "zod"

import { clusterQueueProgressSchema } from "@/models/ingest/types"
import type { ClusterIngestRequest, ClusterQueueProgress } from "./contracts"
import {
  OcrSyncContractError,
  OcrSyncUnavailableError,
  workerOcrQualitySyncResponseSchema,
  type WorkerOcrQualitySyncResponse,
} from "./ocr-quality"

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

/** A worker answer with its body already read (within the deadline). */
type WorkerResponse = { ok: boolean; status: number; statusText: string; text: string }

/** Transport failure or timeout reaching the worker (no HTTP answer at all). */
class WorkerTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "WorkerTransportError"
  }
}

/**
 * One request to the worker, headers AND body bounded by one deadline: the
 * timer is cleared only after the body has been read, so a worker that sends
 * headers and then stalls cannot hang the caller.
 */
async function requestWorker(path: string, init: RequestInit): Promise<WorkerResponse> {
  const base = workerUrl()
  const ms = timeoutMs()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal })
    const text = await res.text()
    return { ok: res.ok, status: res.status, statusText: res.statusText, text }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new WorkerTransportError(`ClusterClient: ${base}${path} timed out after ${ms}ms`, {
        cause: err,
      })
    }
    throw new WorkerTransportError(
      `ClusterClient: request to ${base}${path} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    )
  } finally {
    clearTimeout(timer)
  }
}

function postJson(path: string, body: unknown): Promise<WorkerResponse> {
  return requestWorker(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** Parse a worker body as JSON, or say exactly why it is not. */
function parseJsonBody(label: string, text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(
      `${label}: worker response is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

const submitResponseSchema = z.object({ clusterJobId: z.string().min(1) })

export class ClusterClient {
  static async submit(
    req: ClusterIngestRequest,
  ): Promise<{ clusterJobId: string }> {
    const res = await postJson("/ingest", req)
    if (!res.ok) {
      throw new Error(
        `ClusterClient.submit: worker returned ${res.status} ${res.statusText}: ${res.text}`,
      )
    }
    const parsed = submitResponseSchema.safeParse(parseJsonBody("ClusterClient.submit", res.text))
    if (!parsed.success) {
      throw new Error(`ClusterClient.submit: invalid worker response: ${z.prettifyError(parsed.error)}`)
    }
    return parsed.data
  }

  /**
   * Fetch the worker's live queue-status read-model for a run. Best-effort: it
   * drives the Ingérer live view and the watchdog's staleness clock, NOT the
   * version commit (that rides the terminal callback). A 404 (run unknown or
   * already pruned) is null. An unreachable worker or a non-2xx is ALSO null —
   * the watchdog reads null as "the worker is silent" — but it is logged, never
   * swallowed. A body that is not a valid read-model is a contract break and
   * throws.
   */
  static async progress(
    clusterJobId: string,
  ): Promise<ClusterQueueProgress | null> {
    const path = `/progress/${encodeURIComponent(clusterJobId)}`
    let res: WorkerResponse
    try {
      res = await requestWorker(path, { method: "GET" })
    } catch (err) {
      if (!(err instanceof WorkerTransportError)) throw err
      console.warn(`[cluster] progress ${clusterJobId}: worker unreachable —`, err.message)
      return null
    }
    if (res.status === 404) return null
    if (!res.ok) {
      console.warn(
        `[cluster] progress ${clusterJobId}: worker returned ${res.status} ${res.statusText}: ${res.text}`,
      )
      return null
    }
    const parsed = clusterQueueProgressSchema.safeParse(
      parseJsonBody("ClusterClient.progress", res.text),
    )
    if (!parsed.success) {
      throw new Error(
        `ClusterClient.progress: invalid worker read-model: ${z.prettifyError(parsed.error)}`,
      )
    }
    return parsed.data
  }

  /**
   * POST /ocr-quality/sync — the per-ARK OCR-quality artifacts for `arks`
   * (lib/documents/ocr-sync.ts, plan D7). The worker returns the artifacts it
   * has and queues a rate-gated build for the others.
   *   - no answer, a timeout, a 5xx, or a 404 (a worker older than the
   *     endpoint) → OcrSyncUnavailableError: retry later, nobody at fault;
   *   - any other non-2xx (a 400 refusing an ARK), a non-JSON body or one that
   *     is not a valid sync response → OcrSyncContractError, with the body or
   *     the Zod issues. A contract break is never written to the app DB.
   */
  static async ocrQualitySync(arks: string[]): Promise<WorkerOcrQualitySyncResponse> {
    let res: WorkerResponse
    try {
      res = await postJson("/ocr-quality/sync", { arks })
    } catch (err) {
      if (err instanceof WorkerTransportError) {
        throw new OcrSyncUnavailableError(err.message, { cause: err })
      }
      throw err
    }
    if (res.status >= 500 || res.status === 404) {
      throw new OcrSyncUnavailableError(
        `ClusterClient.ocrQualitySync: worker returned ${res.status} ${res.statusText}: ${res.text}`,
      )
    }
    if (!res.ok) {
      throw new OcrSyncContractError(
        `ClusterClient.ocrQualitySync: worker refused the batch (${res.status} ${res.statusText}): ${res.text}`,
      )
    }
    let json: unknown
    try {
      json = parseJsonBody("ClusterClient.ocrQualitySync", res.text)
    } catch (err) {
      throw new OcrSyncContractError(err instanceof Error ? err.message : String(err), {
        cause: err,
      })
    }
    const parsed = workerOcrQualitySyncResponseSchema.safeParse(json)
    if (!parsed.success) {
      throw new OcrSyncContractError(
        `ClusterClient.ocrQualitySync: invalid worker response: ${z.prettifyError(parsed.error)}`,
      )
    }
    return parsed.data
  }

  static async cancel(clusterJobId: string): Promise<void> {
    const res = await postJson(`/ingest/${encodeURIComponent(clusterJobId)}/cancel`, {})
    if (!res.ok && res.status !== 404) {
      // 404 is acceptable: the job may have already terminated or never existed.
      throw new Error(
        `ClusterClient.cancel: worker returned ${res.status} ${res.statusText}: ${res.text}`,
      )
    }
  }
}
