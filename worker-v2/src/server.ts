/**
 * Worker V2 HTTP ingress — the app↔worker control plane. A tiny Node `http`
 * server (no framework) exposing the five routes the app drives:
 *
 *   GET  /health             → liveness
 *   POST /ingest             → open a run + seed ARKs → { clusterJobId }
 *   GET  /progress/:runId    → buildProgress(runId) read-model (the Ingérer poll)
 *   POST /ingest/:runId/cancel → suppress the terminal callback (best-effort)
 *   POST /ocr-quality/sync   → per-ARK OCR-quality artifacts; queues the
 *                              backfill for the missing ones (live/ocr-quality-sync.ts)
 *
 * `POST /ingest`, `POST /ocr-quality/sync` and the terminal callback are the
 * wire contracts shared with the app; everything else is v2's own clean
 * implementation. The server holds no behaviour — it parses, authorizes by HMAC at
 * the callback (app side), and delegates to the ingress + the read-model.
 *
 * Security posture: none of these routes authenticates its caller — they trust
 * the cluster network (RUN.md, F22). /ocr-quality/sync is unauthenticated by the
 * same design (plan D17): it can at most enqueue rate-gated, idempotent artifact
 * builds, capped at one row per ARK.
 */
import { createServer as createHttpServer, type Server } from "node:http";

import { buildProgress } from "./observability.js";
import type { BlobStore, QueueClient } from "./core/types.js";
import type { Logger } from "./core/types.js";
import type { DocStateStore } from "./domain/doc-state.js";
import type { OcrBackfillWiring } from "./domain/ocr-backfill.js";
import type { RunStore } from "./domain/run.js";
import type { CompletionMonitor } from "./live/completion-monitor.js";
import { createRunAndSeed, parseIngestRequest } from "./live/ingress.js";
import {
  OCR_SYNC_MAX_BODY_BYTES,
  OCR_SYNC_MAX_IN_FLIGHT,
  parseOcrSyncRequest,
  syncOcrQuality,
  type OcrSyncResponse,
} from "./live/ocr-quality-sync.js";

export interface ServerDeps {
  runStore: RunStore;
  docState: DocStateStore;
  queue: QueueClient;
  completion: CompletionMonitor;
  log: Logger;
  /** BnF fetch rate (folios/min) for the read-model ETA. */
  fetchRatePerMin: number;
  /** IIIF manifest rate (manifests/min) for the read-model's metadata-row rate. */
  manifestRatePerMin: number;
  /** The artifact store /ocr-quality/sync reads the per-ARK artifacts from. */
  blob: BlobStore;
  /**
   * The OCR-quality backfill as main.ts wired it — the SAME object
   * buildPipeline used to decide whether the backfill stage runs, so the
   * endpoint enqueues exactly when a consumer exists.
   */
  ocrBackfill: OcrBackfillWiring;
  /** Wall-clock ceiling of one /ocr-quality/sync request (OCR_SYNC_DEADLINE_MS). */
  ocrSyncDeadlineMs: number;
  /** Time allowed to receive a /ocr-quality/sync body (OCR_SYNC_BODY_READ_MS). */
  ocrSyncBodyReadMs: number;
}

/** The /ingest body cap: a full corpus delta (thousands of ARKs with metadata). */
const INGEST_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Time allowed to receive an /ingest body. */
const INGEST_BODY_READ_MS = 30_000;

type BodyRead =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "timeout" | "stream_error"; detail: string };

/**
 * Read a request body to a string, bounded in size AND time. A refusal says
 * why — oversize (413), too slow (408), a broken stream (400) — instead of one
 * catch-all, and the caller logs it.
 */
function readBody(
  req: import("node:http").IncomingMessage,
  opts: { maxBytes: number; timeoutMs: number },
): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (r: BodyRead): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener("data", onData);
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: "timeout", detail: `body not received within ${opts.timeoutMs}ms` }),
      opts.timeoutMs,
    );
    const onData = (c: Buffer): void => {
      size += c.length;
      if (size > opts.maxBytes) {
        // Stop buffering; the response closes the connection (sendRefusal).
        finish({ ok: false, reason: "too_large", detail: `body exceeds ${opts.maxBytes} bytes` });
        return;
      }
      chunks.push(c);
    };
    req.on("data", onData);
    req.on("end", () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", (e) => finish({ ok: false, reason: "stream_error", detail: e.message }));
  });
}

const REFUSAL_STATUS = { too_large: 413, timeout: 408, stream_error: 400 } as const;

/**
 * Read and JSON-parse a body for `route`, or answer the refusal (logged) and
 * return null. An oversize or unfinished body closes the connection: the rest
 * of it is never read.
 */
async function readJsonBody(
  deps: ServerDeps,
  route: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  opts: { maxBytes: number; timeoutMs: number },
): Promise<{ value: unknown } | null> {
  const read = await readBody(req, opts);
  if (!read.ok) {
    deps.log.warn("http_body_rejected", { route, reason: read.reason, detail: read.detail });
    res.setHeader("connection", "close");
    sendJson(res, REFUSAL_STATUS[read.reason], { error: read.detail });
    res.once("finish", () => req.destroy());
    return null;
  }
  try {
    return { value: JSON.parse(read.text) };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    deps.log.warn("http_body_rejected", { route, reason: "invalid_json", detail });
    sendJson(res, 400, { error: `invalid JSON body: ${detail}` });
    return null;
  }
}

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/** Per-server mutable state: the /ocr-quality/sync requests in flight. */
interface ServerState {
  syncInFlight: number;
}

export function createServer(deps: ServerDeps): Server {
  const state: ServerState = { syncInFlight: 0 };
  return createHttpServer((req, res) => {
    void handle(deps, state, req, res).catch((err) => {
      deps.log.error("http_handler_crash", {
        method: req.method,
        url: req.url,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  });
}

async function handle(
  deps: ServerDeps,
  state: ServerState,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  // Path only — drop any query string; the URL base is irrelevant to routing.
  const path = (req.url ?? "/").split("?")[0] ?? "/";

  if (method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && path === "/ingest") {
    await handleIngest(deps, req, res);
    return;
  }

  if (method === "POST" && path === "/ocr-quality/sync") {
    await handleOcrSync(deps, state, req, res);
    return;
  }

  const progressMatch = method === "GET" && /^\/progress\/([^/]+)$/.exec(path);
  if (progressMatch) {
    await handleProgress(deps, decodeURIComponent(progressMatch[1]!), res);
    return;
  }

  const cancelMatch = method === "POST" && /^\/ingest\/([^/]+)\/cancel$/.exec(path);
  if (cancelMatch) {
    await handleCancel(deps, decodeURIComponent(cancelMatch[1]!), res);
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleIngest(
  deps: ServerDeps,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const body = await readJsonBody(deps, "/ingest", req, res, {
    maxBytes: INGEST_MAX_BODY_BYTES,
    timeoutMs: INGEST_BODY_READ_MS,
  });
  if (body === null) return;

  const parsed = parseIngestRequest(body.value);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }

  const { runId, totalDocs } = await createRunAndSeed(
    { runStore: deps.runStore, docState: deps.docState, queue: deps.queue },
    parsed.value,
  );
  deps.log.info("ingest_accepted", {
    runId,
    appJobId: parsed.value.appJobId,
    projectId: parsed.value.projectId,
    totalDocs,
  });

  // A zero-doc (removal-only) run is already complete — fire the completion check
  // so its terminal callback commits the removal. For a normal run this is a cheap
  // no-op (the docs are still queued); the pipeline's onOutcome drives the rest.
  void deps.completion.checkRun(runId).catch((err) =>
    deps.log.error("ingest_completion_kick_failed", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    }),
  );

  // The app contract: { clusterJobId } — v2's runId IS the clusterJobId.
  sendJson(res, 200, { clusterJobId: runId });
}

async function handleOcrSync(
  deps: ServerDeps,
  state: ServerState,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  // Cap the requests in flight BEFORE reading anything: a burst is refused at
  // once (the app retries next sweep) instead of stacking work on the pool.
  if (state.syncInFlight >= OCR_SYNC_MAX_IN_FLIGHT) {
    deps.log.warn("ocr_quality_sync_busy", { inFlight: state.syncInFlight });
    res.setHeader("connection", "close");
    sendJson(res, 503, { error: `${state.syncInFlight} sync requests already in flight` });
    res.once("finish", () => req.destroy());
    return;
  }
  state.syncInFlight += 1;
  try {
    await serveOcrSync(deps, req, res);
  } finally {
    state.syncInFlight -= 1;
  }
}

async function serveOcrSync(
  deps: ServerDeps,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const body = await readJsonBody(deps, "/ocr-quality/sync", req, res, {
    maxBytes: OCR_SYNC_MAX_BODY_BYTES,
    timeoutMs: deps.ocrSyncBodyReadMs,
  });
  if (body === null) return;
  const parsed = parseOcrSyncRequest(body.value);
  if (!parsed.ok) {
    deps.log.warn("ocr_quality_sync_bad_request", { error: parsed.error });
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  const { arks } = parsed.value;
  // The deadline CANCELS: the signal stops every ARK at its next step (no new
  // S3 read or store transaction); a won claim still gets its send or release.
  const deadline = AbortSignal.timeout(deps.ocrSyncDeadlineMs);
  let response: OcrSyncResponse;
  try {
    response = await syncOcrQuality(
      { blob: deps.blob, queue: deps.queue, log: deps.log, backfill: deps.ocrBackfill },
      arks,
      deadline,
    );
  } catch (e) {
    if (!deadline.aborted) throw e;
    deps.log.warn("ocr_quality_sync_deadline", { asked: arks.length, deadlineMs: deps.ocrSyncDeadlineMs });
    sendJson(res, 503, { error: `sync did not finish within ${deps.ocrSyncDeadlineMs}ms` });
    return;
  }
  deps.log.info("ocr_quality_sync", {
    asked: arks.length,
    documents: response.documents.length,
    building: response.building.length,
    unavailable: response.unavailable.length,
  });
  sendJson(res, 200, response);
}

async function handleProgress(
  deps: ServerDeps,
  runId: string,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const run = await deps.runStore.get(runId);
  if (!run) {
    sendJson(res, 404, { error: "run not found" });
    return;
  }
  const report = await buildProgress(deps.docState, deps.queue, {
    runId,
    fetchRatePerMin: deps.fetchRatePerMin,
    manifestRatePerMin: deps.manifestRatePerMin,
  });
  sendJson(res, 200, report);
}

async function handleCancel(
  deps: ServerDeps,
  runId: string,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const run = await deps.runStore.get(runId);
  if (!run) {
    // The app treats 404 as "already gone" — acceptable.
    sendJson(res, 404, { error: "run not found" });
    return;
  }
  // Best-effort: suppress the terminal callback. In-flight stage work is not
  // interrupted (the pipeline has no cancel path); the app has already marked its
  // own job canceled, so a late terminal event would only be ignored anyway.
  await deps.runStore.markCanceled(runId);
  deps.log.info("ingest_canceled", { runId });
  sendJson(res, 200, { canceled: true });
}

/** Bind the server to a port. Resolves once listening. */
export function startServer(deps: ServerDeps, port: number): Promise<Server> {
  const server = createServer(deps);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      deps.log.info("http_ingress_up", { port });
      resolve(server);
    });
  });
}
