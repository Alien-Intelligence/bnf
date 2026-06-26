/**
 * Worker V2 HTTP ingress — the app↔worker control plane. A tiny Node `http`
 * server (no framework) exposing the four routes the app drives:
 *
 *   GET  /health             → liveness
 *   POST /ingest             → open a run + seed ARKs → { clusterJobId }
 *   GET  /progress/:runId    → buildProgress(runId) read-model (the Ingérer poll)
 *   POST /ingest/:runId/cancel → suppress the terminal callback (best-effort)
 *
 * `POST /ingest` and the terminal callback are the only two wire contracts shared
 * with the app (see the Phase 0 wire doc); everything else is v2's own clean
 * implementation. The server holds no behaviour — it parses, authorizes by HMAC at
 * the callback (app side), and delegates to the ingress + the read-model.
 */
import { createServer as createHttpServer, type Server } from "node:http";

import { buildProgress } from "./observability.js";
import type { QueueClient } from "./core/types.js";
import type { Logger } from "./core/types.js";
import type { DocStateStore } from "./domain/doc-state.js";
import type { RunStore } from "./domain/run.js";
import type { CompletionMonitor } from "./live/completion-monitor.js";
import { createRunAndSeed, parseIngestRequest } from "./live/ingress.js";

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
}

/** Read a request body to a string, capped to guard against unbounded uploads. */
function readBody(
  req: import("node:http").IncomingMessage,
  maxBytes = 8 * 1024 * 1024,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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

export function createServer(deps: ServerDeps): Server {
  return createHttpServer((req, res) => {
    void handle(deps, req, res).catch((err) => {
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
  let raw: unknown;
  try {
    const text = await readBody(req);
    raw = JSON.parse(text);
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }

  const parsed = parseIngestRequest(raw);
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
