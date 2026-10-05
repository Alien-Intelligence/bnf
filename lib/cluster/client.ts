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
 * The ARKs a refused or invalid answer can be pinned on, or [] when the
 * fault is the exchange itself. Exported for the tests.
 */
export function culpritsOf(
  asked: string[],
  failure:
    | { kind: "refusal"; body: string }
    | { kind: "invalid"; raw: unknown; issuePaths: PropertyKey[][] },
): string[] {
  if (failure.kind === "refusal") {
    const body = tryJson(failure.body)
    if (!isRecord(body) || typeof body.error !== "string") return []
    const m = ARK_REFUSAL.exec(body.error)
    if (m === null) return []
    const ark = asked[Number(m[1])]
    return ark === undefined ? [] : [ark]
  }
  // An invalid answer. Each issue is pinned on the ARK of the entry it is in
  // (an issue outside such an entry — a missing top-level key, a wrong type —
  // is the exchange's fault). Then, per bucket (documents / building /
  // unavailable): if NO entry of that bucket passed, the worker cannot speak
  // this contract at all (a version skew: `v: 2`, a renamed field) and nobody
  // is blamed — the sync pauses, which is recoverable, whereas blaming every
  // ARK quarantines them, which is not. Per-ARK blame only when at least one
  // entry of the same bucket in the same answer passed.
  if (!isRecord(failure.raw)) return []
  const askedSet = new Set(asked)
  const failingByBucket = new Map<string, Map<number, string>>()
  for (const path of failure.issuePaths) {
    const [bucket, index] = path
    if (typeof bucket !== "string" || typeof index !== "number") return []
    const entries = failure.raw[bucket]
    if (!Array.isArray(entries)) return []
    const entry: unknown = entries[index]
    const ark = typeof entry === "string" ? entry : isRecord(entry) ? entry.ark : undefined
    if (typeof ark !== "string" || !askedSet.has(ark)) return []
    const failing = failingByBucket.get(bucket) ?? new Map<number, string>()
    failing.set(index, ark)
    failingByBucket.set(bucket, failing)
  }
  const culprits = new Set<string>()
  for (const [bucket, failing] of failingByBucket) {
    const entries = failure.raw[bucket]
    const entryCount = Array.isArray(entries) ? entries.length : 0
    if (failing.size >= entryCount) return [] // no entry of this bucket passed
    for (const ark of failing.values()) culprits.add(ark)
  }
  return [...culprits]
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
   *   - no answer, a timeout, a 5xx, or a 404 (a worker older than the
   *     endpoint) → OcrSyncUnavailableError;
   *   - a 400 naming `arks[i]` → OcrSyncContractError pinned on that ARK; any
   *     other 4xx (401, 403, 413, an unknown key…) or a body that is not JSON
   *     → OcrSyncContractError on the EXCHANGE;
   *   - a body outside the schema → pinned on the ARKs of the invalid entries
   *     when they can be named, else on the exchange.
   * A contract break is never written to the app DB.
   */
  static async ocrQualitySync(
    arks: string[],
    signal?: AbortSignal,
  ): Promise<WorkerOcrQualitySyncResponse> {
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
      const culprits = res.status === 400 ? culpritsOf(arks, { kind: "refusal", body: res.text }) : []
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
      throw new OcrSyncContractError(
        err instanceof Error ? err.message : String(err),
        { scope: OCR_SYNC_FAULT_SCOPE.EXCHANGE, culprits: [] },
        { cause: err },
      )
    }
    const parsed = workerOcrQualitySyncResponseSchema.safeParse(json)
    if (!parsed.success) {
      const culprits = culpritsOf(arks, {
        kind: "invalid",
        raw: json,
        issuePaths: parsed.error.issues.map((i) => i.path),
      })
      throw new OcrSyncContractError(
        `ClusterClient.ocrQualitySync: invalid worker response: ${z.prettifyError(parsed.error)}`,
        culprits.length > 0
          ? { scope: OCR_SYNC_FAULT_SCOPE.ARKS, culprits }
          : { scope: OCR_SYNC_FAULT_SCOPE.EXCHANGE, culprits: [] },
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
