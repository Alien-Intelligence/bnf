/**
 * Long-running ingest worker WITH HTTP API.
 *
 * Same as scripts/04-worker.ts, but also serves an HTTP API on
 * WORKER_HTTP_PORT (default 7777):
 *
 *   POST /ingest                       — app → worker submit
 *   POST /ingest/:clusterJobId/cancel  — app → worker cancel (best-effort)
 *   GET  /health                       — liveness probe
 *
 * Each /ingest call:
 *   1. Stores a `cluster_ingest_request` row mapping clusterJobId ↔ appJobId
 *      and the per-job callbackUrl + callbackSecret.
 *   2. Calls IngestOrchestrator.submit (creates sandbox_ingest.ingest_job +
 *      child doc-jobs, enqueues pg-boss jobs).
 *   3. Returns { clusterJobId } so the app can persist it on its IngestJob row.
 *
 * Progress callbacks back to the app are emitted by the runner's
 * `onTransition` hook after every per-doc state change. See
 * src/queue/callback.ts.
 */

import "./_loadenv.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import { Pool } from "pg";
import { db, ingest } from "../src/env.js";
import { bnfDatasetSlug, getClusterSink } from "../src/cluster/index.js";
import { createPreparePipeline } from "../src/prepare/index.js";
import { arkToSlug } from "../src/slug.js";
import type { ClusterSink } from "../src/types.js";

/** Resolves (and caches) a project's dataset id — defined in main(). */
type ResolveDatasetId = (projectId: string) => Promise<number>;
import {
  DOC_QUEUE_NAME,
  DocumentIngestRunner,
  emitProgressForIngestJob,
  getBoss,
  IngestOrchestrator,
  installSearchPath,
  markCanceled,
  migrate,
  Repo,
  stopBoss,
  type DocJobQueuePayload,
} from "../src/queue/index.js";

const CONCURRENCY = Math.max(
  1,
  parseInt(process.env.WORKER_CONCURRENCY ?? "4", 10),
);

const HTTP_PORT = parseInt(process.env.WORKER_HTTP_PORT ?? "7777", 10);
const APP_BASE_URL = process.env.APP_BASE_URL; // optional callbackUrl host allow-list

// ---------------------------------------------------------------------------
// Inbound request validation
// ---------------------------------------------------------------------------

interface InboundIngestRequest {
  projectId: string;
  targetVersionId: string;
  appJobId: string;
  added: Array<{ ark: string }>;
  removed: string[];
  callbackUrl: string;
  callbackSecret: string;
}

function isStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function parseInbound(body: unknown): InboundIngestRequest | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (!isStr(b.projectId)) return "projectId required";
  if (!isStr(b.targetVersionId)) return "targetVersionId required";
  if (!isStr(b.appJobId)) return "appJobId required";
  if (!isStr(b.callbackUrl)) return "callbackUrl required";
  if (!isStr(b.callbackSecret)) return "callbackSecret required";
  if (b.callbackSecret.length < 16) return "callbackSecret too short";
  if (!Array.isArray(b.added)) return "added must be an array";
  if (!Array.isArray(b.removed)) return "removed must be an array";
  const added: Array<{ ark: string }> = [];
  for (const item of b.added) {
    if (
      !item ||
      typeof item !== "object" ||
      !isStr((item as Record<string, unknown>).ark)
    ) {
      return "added[].ark required";
    }
    added.push({ ark: (item as Record<string, unknown>).ark as string });
  }
  if (APP_BASE_URL) {
    try {
      const u = new URL(b.callbackUrl);
      const a = new URL(APP_BASE_URL);
      if (u.host !== a.host) {
        return `callbackUrl host '${u.host}' does not match APP_BASE_URL host '${a.host}'`;
      }
    } catch {
      return "callbackUrl is not a valid URL";
    }
  }
  return {
    projectId: b.projectId,
    targetVersionId: b.targetVersionId,
    appJobId: b.appJobId,
    added,
    removed: b.removed.filter(isStr),
    callbackUrl: b.callbackUrl,
    callbackSecret: b.callbackSecret,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 4 * 1024 * 1024; // 4 MiB
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(json).toString());
  res.end(json);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: db.url() });
  installSearchPath(pool);
  await migrate(pool);
  console.log("[worker-api] schema migrated");

  const repo = new Repo(pool);
  const boss = await getBoss();
  await boss.createQueue(DOC_QUEUE_NAME).catch(() => undefined);
  console.log(`[worker-api] pg-boss started, queue '${DOC_QUEUE_NAME}' ready`);

  const orchestrator = new IngestOrchestrator(repo, boss);

  // ---- Composition root: real Track 1 + Track 3 implementations. ----
  const docPipeline = createPreparePipeline({
    // Hard ceiling on OCR pages so the worst-case doc runtime stays bounded
    // within the pg-boss expire window (see src/env.ts `ingest`).
    maxOcrPages: ingest.maxOcrPages(),
    maxImageCanvases: process.env.MAX_IMAGE_CANVASES
      ? parseInt(process.env.MAX_IMAGE_CANVASES, 10)
      : undefined,
    imageConcurrency: process.env.IMAGE_CONCURRENCY
      ? parseInt(process.env.IMAGE_CONCURRENCY, 10)
      : undefined,
  });
  const clusterSink = getClusterSink();
  const datasetIdCache = new Map<string, number>();
  const resolveDatasetId = async (projectId: string): Promise<number> => {
    const cached = datasetIdCache.get(projectId);
    if (cached !== undefined) return cached;
    const slug = bnfDatasetSlug(projectId);
    const { datasetId } = await clusterSink.ensureDataset({
      projectId,
      name: `BnF — ${projectId}`,
      slug,
    });
    datasetIdCache.set(projectId, datasetId);
    return datasetId;
  };

  const runner = new DocumentIngestRunner(
    docPipeline,
    clusterSink,
    resolveDatasetId,
    repo,
    undefined,
    (ingestJobId) => emitProgressForIngestJob(pool, ingestJobId),
  );

  await boss.work<DocJobQueuePayload>(
    DOC_QUEUE_NAME,
    { batchSize: CONCURRENCY, pollingIntervalSeconds: 1 },
    async (jobs) => {
      // Per-job try/catch + boss.fail(): the runner rethrows TransientBnfError
      // so pg-boss's retryLimit/retryDelay/retryBackoff actually fires. Letting
      // a single throw escape this batch handler would fail ALL N jobs in the
      // batch — so we mark only the throwing job as failed and leave the
      // others to complete normally.
      await Promise.all(
        jobs.map(async (job) => {
          try {
            await runner.run(job.data.docJobId);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(
              `[worker-api] runner threw for doc=${job.data.docJobId} job=${job.id}; marking for retry: ${message}`,
            );
            await boss
              .fail(DOC_QUEUE_NAME, job.id, { error: message })
              .catch((failErr) =>
                console.error("[worker-api] boss.fail() itself failed:", failErr),
              );
          }
        }),
      );
    },
  );
  console.log(
    `[worker-api] consuming '${DOC_QUEUE_NAME}' with concurrency=${CONCURRENCY}`,
  );

  // ---- HTTP server ----
  const server = createServer((req, res) => {
    void handleRequest(
      req,
      res,
      orchestrator,
      pool,
      clusterSink,
      resolveDatasetId,
      repo,
    ).catch((err) => {
      console.error("[worker-api] request handler crashed:", err);
      send(res, 500, { error: "internal" });
    });
  });

  server.listen(HTTP_PORT, () => {
    console.log(`[worker-api] HTTP listening on :${HTTP_PORT}`);
  });

  // ---- Graceful shutdown ----
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker-api] ${signal} received — draining`);
    server.close();
    try {
      await stopBoss();
    } catch (err) {
      console.error("[worker-api] error stopping pg-boss:", err);
    }
    try {
      await pool.end();
    } catch (err) {
      console.error("[worker-api] error closing pool:", err);
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

/**
 * Delete each removed ARK's entry from the project's dataset. Idempotent +
 * best-effort: an already-absent entry is a no-op; a failed delete is logged and
 * counted but does not abort the rest. Returns the done/failed tally.
 */
async function runRemovals(
  clusterSink: ClusterSink,
  resolveDatasetId: ResolveDatasetId,
  repo: Repo,
  projectId: string,
  removedArks: string[],
): Promise<{ removedDone: number; removedFailed: number }> {
  const datasetId = await resolveDatasetId(projectId);
  let removedDone = 0;
  let removedFailed = 0;
  for (const ark of removedArks) {
    try {
      await clusterSink.removeEntry({ datasetId, arkSlug: arkToSlug(ark) });
      // Clear the doc's ingest state so a future re-add doesn't short-circuit
      // against a deleted entry. The BLOB cache (doc.json/chunks/vectors) is
      // intentionally LEFT in place — that's what makes the re-add cheap.
      await repo.clearDocState(projectId, ark);
      removedDone++;
    } catch (err) {
      removedFailed++;
      console.warn(
        `[worker-api] removal failed for ${ark}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log(
    `[worker-api] removals for project=${projectId}: ${removedDone} removed, ${removedFailed} failed`,
  );
  return { removedDone, removedFailed };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  orchestrator: IngestOrchestrator,
  pool: Pool,
  clusterSink: ClusterSink,
  resolveDatasetId: ResolveDatasetId,
  repo: Repo,
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && url === "/health") {
    send(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && url === "/ingest") {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      send(res, 413, {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(res, 400, { error: "invalid JSON" });
      return;
    }
    const valid = parseInbound(parsed);
    if (typeof valid === "string") {
      send(res, 400, { error: valid });
      return;
    }
    if (valid.added.length === 0 && valid.removed.length === 0) {
      send(res, 400, {
        error: "added and removed are both empty — nothing to do",
      });
      return;
    }
    const arks = valid.added.map((d) => d.ark);
    // added → child doc-jobs (may be empty for a removal-only delta).
    // removed → handled below as a discrete delete pass (no doc-jobs needed).
    let submitted;
    try {
      submitted = await orchestrator.submit({
        projectId: valid.projectId,
        arks,
      });
    } catch (err) {
      console.error("[worker-api] orchestrator.submit failed:", err);
      send(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const clusterJobId = `${valid.targetVersionId}-${Date.now()}-${crypto
      .randomBytes(4)
      .toString("hex")}`;
    try {
      await pool.query(
        `INSERT INTO cluster_ingest_request
          (cluster_job_id, app_job_id, project_id, ingest_job_id,
           target_version_id, callback_url, callback_secret, total_docs, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running')`,
        [
          clusterJobId,
          valid.appJobId,
          valid.projectId,
          submitted.ingestJobId,
          valid.targetVersionId,
          valid.callbackUrl,
          valid.callbackSecret,
          arks.length,
        ],
      );
    } catch (err) {
      console.error("[worker-api] failed to persist cluster_ingest_request:", err);
      send(res, 500, { error: "failed to persist ingest request" });
      return;
    }
    console.log(
      `[worker-api] ingest accepted: cluster=${clusterJobId} app=${valid.appJobId} ingest=${submitted.ingestJobId} docs=${arks.length} removed=${valid.removed.length}`,
    );
    send(res, 200, { clusterJobId });

    // Corpus-delta removals: delete each removed ARK's entry from the dataset.
    // Run AFTER responding (the deletes are independent of the added doc-jobs).
    // For a removal-ONLY delta there are no child jobs to drive the terminal
    // callback, so we emit it here once the deletes finish — otherwise the app
    // job would never leave "running".
    if (valid.removed.length > 0) {
      const removalOnly = arks.length === 0
      void runRemovals(clusterSink, resolveDatasetId, repo, valid.projectId, valid.removed)
        .then(async () => {
          if (removalOnly) await emitProgressForIngestJob(pool, submitted.ingestJobId)
        })
        .catch((err: unknown) => {
          console.error("[worker-api] removal pass failed:", err)
          // Best-effort: still try to finalize a removal-only job so it doesn't hang.
          if (removalOnly) {
            void emitProgressForIngestJob(pool, submitted.ingestJobId).catch(() => {})
          }
        })
    } else if (arks.length === 0) {
      // Defensive: empty added + empty removed shouldn't reach here (rejected
      // above), but if it did, finalize so the job can't hang.
      void emitProgressForIngestJob(pool, submitted.ingestJobId).catch(() => {})
    }
    return;
  }

  const cancelMatch = /^\/ingest\/([^/]+)\/cancel$/.exec(url);
  if (method === "POST" && cancelMatch) {
    const clusterJobId = decodeURIComponent(cancelMatch[1]!);
    try {
      await markCanceled(pool, clusterJobId);
    } catch (err) {
      console.error("[worker-api] markCanceled failed:", err);
      send(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    send(res, 200, { canceled: clusterJobId });
    return;
  }

  send(res, 404, { error: "not found" });
}

main().catch((err) => {
  console.error("[worker-api] fatal:", err);
  process.exit(1);
});
