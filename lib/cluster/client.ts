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
import {
  CLUSTER_POLL,
  type ClusterIngestRequest,
  type ClusterProgressPoll,
} from "./contracts"
import {
  OCR_SYNC_FAULT_SCOPE,
  OcrSyncContractError,
  OcrSyncUnavailableError,
  readWorkerSyncAnswer,
  type WorkerSyncAnswer,
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

/** The per-request ceiling of every worker call (WORKER_RUNNER_TIMEOUT_MS). */
export function workerRequestTimeoutMs(): number {
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
 * headers and then stalls cannot hang the caller. A caller's `signal` (a
 * drain's deadline) cancels the request too.
 */
async function requestWorker(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<WorkerResponse> {
  const base = workerUrl()
  const ms = workerRequestTimeoutMs()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  try {
    const res = await fetch(`${base}${path}`, { ...init, signal: combined })
    const text = await res.text()
    return { ok: res.ok, status: res.status, statusText: res.statusText, text }
  } catch (err) {
    if (signal?.aborted) {
      throw new WorkerTransportError(`ClusterClient: ${base}${path} cancelled by the caller`, {
        cause: err,
      })
    }
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

function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<WorkerResponse> {
  return requestWorker(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    signal,
  )
}

/** A worker 400 naming one request entry: `{"error":"arks[<i>]…"}`. */
const ARK_REFUSAL = /^arks\[(\d+)\]/

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

/** Parse text as JSON, or undefined when it is not JSON. */
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * The ARK a 400 refusal names (`arks[i]` …), or [] when the refusal is about
 * the exchange itself. Exported for the tests.
 */
export function refusedArks(asked: string[], body: string): string[] {
  const parsed = tryJson(body)
  if (!isRecord(parsed) || typeof parsed.error !== "string") return []
  const m = ARK_REFUSAL.exec(parsed.error)
  if (m === null) return []
  const ark = asked[Number(m[1])]
  return ark === undefined ? [] : [ark]
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
   * Poll the worker's live queue-status read-model for a run. It drives the
   * Ingérer live view and the watchdog's staleness clock, NOT the version
   * commit (that rides the terminal callback). The four outcomes stay apart so
   * an outage is never read as "the run is gone": 404 → run_unknown; no answer
   * → worker_unreachable; any other non-2xx → worker_error (logged). A 2xx body
   * that is not a valid read-model is a contract break and throws.
   */
  /**
   * GET /health: whether the worker process answers at all — the OCR sync's
   * control of last resort, when no document is `available` to ask instead.
   * true on 2xx; false when it is unreachable, times out or answers non-2xx
   * (that IS the answer, logged). A caller's cancellation throws.
   */
  static async workerHealthy(signal: AbortSignal): Promise<boolean> {
    try {
      const res = await requestWorker("/health", { method: "GET" }, signal)
      if (!res.ok) console.warn(`[cluster] worker health: ${res.status} ${res.statusText}`)
      return res.ok
    } catch (err) {
      if (!(err instanceof WorkerTransportError)) throw err
      if (signal.aborted) throw err
      console.warn("[cluster] worker health: unreachable —", err.message)
      return false
    }
  }

  static async progress(clusterJobId: string): Promise<ClusterProgressPoll> {
    const path = `/progress/${encodeURIComponent(clusterJobId)}`
    let res: WorkerResponse
    try {
      res = await requestWorker(path, { method: "GET" })
    } catch (err) {
      if (!(err instanceof WorkerTransportError)) throw err
      console.warn(`[cluster] progress ${clusterJobId}: worker unreachable —`, err.message)
      return { kind: CLUSTER_POLL.WORKER_UNREACHABLE, detail: err.message }
    }
    if (res.status === 404) return { kind: CLUSTER_POLL.RUN_UNKNOWN }
    if (!res.ok) {
      console.warn(
        `[cluster] progress ${clusterJobId}: worker returned ${res.status} ${res.statusText}: ${res.text}`,
      )
      return { kind: CLUSTER_POLL.WORKER_ERROR, status: res.status }
    }
    const parsed = clusterQueueProgressSchema.safeParse(
      parseJsonBody("ClusterClient.progress", res.text),
    )
    if (!parsed.success) {
      throw new Error(
        `ClusterClient.progress: invalid worker read-model: ${z.prettifyError(parsed.error)}`,
      )
    }
    return { kind: CLUSTER_POLL.PROGRESS, progress: parsed.data }
  }

  /**
   * POST /ocr-quality/sync — the per-ARK OCR-quality artifacts for `arks`
   * (lib/documents/ocr-sync.ts, plan D7). The worker returns the artifacts it
   * has and queues a rate-gated build for the others. `signal` (the drain's
   * deadline) cancels the request.
   *   - TRANSPORT (says nothing about any document) → OcrSyncUnavailableError:
   *     no answer, a timeout, a 5xx, a 404 (a worker older than the endpoint),
   *     a 2xx body that is not JSON;
   *   - a 400 naming `arks[i]` → OcrSyncContractError pinned on that ARK; any
   *     other 4xx (401, 403, 413, an unknown key…) → OcrSyncContractError on
   *     the EXCHANGE;
   *   - a JSON body is read in two layers (readWorkerSyncAnswer): an envelope
   *     that does not parse → OcrSyncContractError on the EXCHANGE; otherwise
   *     each document is judged alone and comes back as valid, `incompatible`
   *     (another artifact version) or `broken` (the expected version, failing
   *     its schema) — the caller decides what each one means.
   * A contract break is never written to the app DB.
   */
  static async ocrQualitySync(arks: string[], signal?: AbortSignal): Promise<WorkerSyncAnswer> {
    let res: WorkerResponse
    try {
      res = await postJson("/ocr-quality/sync", { arks }, signal)
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
      const culprits = res.status === 400 ? refusedArks(arks, res.text) : []
      throw new OcrSyncContractError(
        `ClusterClient.ocrQualitySync: worker refused the batch (${res.status} ${res.statusText}): ${res.text}`,
        culprits.length > 0
          ? { scope: OCR_SYNC_FAULT_SCOPE.ARKS, culprits }
          : { scope: OCR_SYNC_FAULT_SCOPE.EXCHANGE, culprits: [] },
      )
    }
    let json: unknown
    try {
      json = parseJsonBody("ClusterClient.ocrQualitySync", res.text)
    } catch (err) {
      // A truncated or proxy-mangled body: the transport failed, not a document.
      throw new OcrSyncUnavailableError(err instanceof Error ? err.message : String(err), {
        cause: err,
      })
    }
    const read = readWorkerSyncAnswer(json)
    if (!read.ok) {
      throw new OcrSyncContractError(
        `ClusterClient.ocrQualitySync: the answer's envelope is not a sync response: ${read.message}`,
        { scope: OCR_SYNC_FAULT_SCOPE.EXCHANGE, culprits: [] },
      )
    }
    return read.answer
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
