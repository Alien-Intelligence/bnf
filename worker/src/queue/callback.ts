/**
 * Cluster → app progress-callback emitter.
 *
 * After every per-document state transition the runner persists, we may need
 * to POST a `ClusterProgressEvent` to the app's callback URL (HMAC-signed).
 *
 * Responsibilities:
 *   - Track the `cluster_ingest_request` row that owns this ingest job.
 *   - Compute aggregate 4-stage progress from the per-doc job counters.
 *   - Coalesce: emit at most one running-stage event every COALESCE_MS, OR
 *     immediately when the stage threshold changes (e.g. extract→chunk), OR
 *     on terminal (done / failed).
 *   - Sign each request with HMAC-SHA256 over the JSON body.
 */

import crypto from "node:crypto";
import type { Pool } from "pg";

const COALESCE_MS = 2000;

type Stage = "extract" | "chunk" | "embed" | "index";

interface ClusterIngestRequestRow {
  cluster_job_id: string;
  app_job_id: string;
  project_id: string;
  ingest_job_id: string;
  target_version_id: string;
  callback_url: string;
  callback_secret: string;
  total_docs: number;
  status: string;
  canceled: boolean;
}

interface DocCounters {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  indexing: number;
  embedding: number;
  chunking: number;
  extracting: number;
  awaitingRetry: number;
  pending: number;
}

/**
 * Per-ingest-job emitter state. Memory-only: if the worker restarts we may
 * emit a duplicate event, which is fine — `IngestService.applyProgress` is
 * idempotent (it overwrites stage/progress).
 */
interface EmitterState {
  lastSentAt: number;
  lastStage: Stage | null;
  finalized: boolean;
  pending: NodeJS.Timeout | null;
}

const emitters = new Map<string, EmitterState>();

function getOrInit(clusterJobId: string): EmitterState {
  let s = emitters.get(clusterJobId);
  if (!s) {
    s = { lastSentAt: 0, lastStage: null, finalized: false, pending: null };
    emitters.set(clusterJobId, s);
  }
  return s;
}

function sign(body: string, secret: string): string {
  return (
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")
  );
}

async function fetchRequest(
  pool: Pool,
  ingestJobId: string,
): Promise<ClusterIngestRequestRow | null> {
  const { rows } = await pool.query<ClusterIngestRequestRow>(
    `SELECT * FROM cluster_ingest_request WHERE ingest_job_id = $1`,
    [ingestJobId],
  );
  return rows[0] ?? null;
}

/**
 * Per-doc failure records for the terminal callback. The app stores these in
 * `ingest_job.stats.errors` and `IngestService.retryFailed` reads them to
 * re-queue exactly the failed ARKs. Without this the retry path is inert (it
 * has no ARK list to work from) and failures are unrecoverable.
 *
 * `stage` is best-effort: the doc-job row doesn't record which of the four
 * stages it died in, but transient failures are overwhelmingly in extract
 * (Gallica fetch / vision), so we label them that way for the UI/record. The
 * value is informational — retryFailed keys off `ark` alone.
 */
async function fetchFailedErrors(
  pool: Pool,
  ingestJobId: string,
): Promise<Array<{ ark: string; stage: string; reason: string }>> {
  const { rows } = await pool.query<{ ark: string; error: string | null }>(
    `SELECT ark, error
       FROM document_ingest_job
      WHERE ingest_job_id = $1 AND status = 'failed'`,
    [ingestJobId],
  );
  return rows.map((r) => ({
    ark: r.ark,
    stage: "extract",
    reason: r.error ?? "unknown",
  }));
}

async function fetchCounters(
  pool: Pool,
  ingestJobId: string,
): Promise<DocCounters> {
  const { rows } = await pool.query<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n
       FROM document_ingest_job
      WHERE ingest_job_id = $1
      GROUP BY status`,
    [ingestJobId],
  );
  const c: DocCounters = {
    total: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    indexing: 0,
    embedding: 0,
    chunking: 0,
    extracting: 0,
    awaitingRetry: 0,
    pending: 0,
  };
  for (const r of rows) {
    const n = parseInt(r.n, 10);
    c.total += n;
    switch (r.status) {
      case "done":
        c.done += n;
        break;
      case "failed":
        c.failed += n;
        break;
      case "skipped":
        c.skipped += n;
        break;
      case "indexing":
        c.indexing += n;
        break;
      case "embedding":
        c.embedding += n;
        break;
      case "chunking":
        c.chunking += n;
        break;
      case "extracting":
        c.extracting += n;
        break;
      case "awaiting_retry":
        // Pre-extract from a stage-progress perspective — the doc is
        // parked in pg-boss waiting to be re-delivered.
        c.awaitingRetry += n;
        break;
      case "pending":
        c.pending += n;
        break;
      default:
        // unknown status — ignore
        break;
    }
  }
  return c;
}

/**
 * Map per-doc counters → 4-stage aggregate fractions.
 *
 *   extract  : count(reached chunking-or-later OR skipped)        / total
 *   chunk    : count(reached embedding-or-later OR skipped)       / total
 *   embed    : count(reached indexing-or-later  OR skipped)       / total
 *   index    : count(done OR skipped)                              / total
 *
 * The "current stage" is the earliest of those four whose fraction < 1.
 * Once index hits 1, terminal handling kicks in.
 */
function computeStage(c: DocCounters): {
  stage: Stage;
  fraction: number;
  counters: Record<string, number>;
} {
  const total = Math.max(1, c.total);
  const passedExtract =
    c.chunking +
    c.embedding +
    c.indexing +
    c.done +
    c.skipped +
    c.failed;
  const passedChunk =
    c.embedding + c.indexing + c.done + c.skipped + c.failed;
  const passedEmbed = c.indexing + c.done + c.skipped + c.failed;
  const passedIndex = c.done + c.skipped + c.failed;

  const fExtract = passedExtract / total;
  const fChunk = passedChunk / total;
  const fEmbed = passedEmbed / total;
  const fIndex = passedIndex / total;

  let stage: Stage = "extract";
  let fraction = fExtract;
  if (fExtract >= 1) {
    stage = "chunk";
    fraction = fChunk;
  }
  if (fChunk >= 1) {
    stage = "embed";
    fraction = fEmbed;
  }
  if (fEmbed >= 1) {
    stage = "index";
    fraction = fIndex;
  }

  return {
    stage,
    fraction,
    counters: {
      total: c.total,
      done: c.done,
      failed: c.failed,
      skipped: c.skipped,
      indexing: c.indexing,
      embedding: c.embedding,
      chunking: c.chunking,
      extracting: c.extracting,
      awaiting_retry: c.awaitingRetry,
      pending: c.pending,
    },
  };
}

async function postSigned(
  url: string,
  secret: string,
  payload: unknown,
): Promise<void> {
  const body = JSON.stringify(payload);
  const sig = sign(body, secret);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-callback-signature": sig,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[callback] ${url} returned ${res.status} ${res.statusText}: ${text.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.error(
      `[callback] POST ${url} failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Public entry point — call this after each per-doc state transition.
 * Coalesces running-stage events; flushes immediately on stage transition or
 * terminal state.
 */
export async function emitProgressForIngestJob(
  pool: Pool,
  ingestJobId: string,
): Promise<void> {
  const req = await fetchRequest(pool, ingestJobId);
  if (!req) return; // sandbox-only run (no app), nothing to do
  if (req.status !== "running") return; // already finalized

  const state = getOrInit(req.cluster_job_id);
  if (state.finalized) return;

  const counters = await fetchCounters(pool, ingestJobId);
  const allTerminal =
    counters.total > 0 &&
    counters.done + counters.failed + counters.skipped === counters.total;

  if (allTerminal) {
    state.finalized = true;
    if (state.pending) {
      clearTimeout(state.pending);
      state.pending = null;
    }
    // Per-doc failure list travels with BOTH terminal shapes so the app can
    // record it (stats.errors) and retryFailed can re-queue exactly these ARKs.
    const errors =
      counters.failed > 0 ? await fetchFailedErrors(pool, ingestJobId) : [];
    const anyUnhandled = counters.failed > 0 && counters.done === 0;
    if (anyUnhandled) {
      await postSigned(req.callback_url, req.callback_secret, {
        stage: "failed",
        error: `${counters.failed}/${counters.total} documents failed`,
        partialStats: {
          done: counters.done,
          failed: counters.failed,
          skipped: counters.skipped,
          total: counters.total,
          errors,
        },
      });
      await pool.query(
        `UPDATE cluster_ingest_request SET status = 'failed', last_progress_at = now() WHERE cluster_job_id = $1`,
        [req.cluster_job_id],
      );
    } else {
      await postSigned(req.callback_url, req.callback_secret, {
        stage: "done",
        chunksWritten: 0, // sandbox doesn't track aggregate yet; per-doc rows have the detail
        stats: {
          done: counters.done,
          failed: counters.failed,
          skipped: counters.skipped,
          total: counters.total,
          errors,
        },
      });
      await pool.query(
        `UPDATE cluster_ingest_request SET status = 'done', last_progress_at = now() WHERE cluster_job_id = $1`,
        [req.cluster_job_id],
      );
    }
    return;
  }

  const { stage, fraction, counters: payloadCounters } = computeStage(counters);
  const now = Date.now();
  const stageChanged = state.lastStage !== null && state.lastStage !== stage;
  const elapsed = now - state.lastSentAt;

  if (!stageChanged && elapsed < COALESCE_MS) {
    // Defer: schedule a single trailing send unless one is already pending.
    if (!state.pending) {
      state.pending = setTimeout(() => {
        state.pending = null;
        emitProgressForIngestJob(pool, ingestJobId).catch((err) => {
          console.error("[callback] deferred emit failed:", err);
        });
      }, COALESCE_MS - elapsed);
    }
    return;
  }

  state.lastSentAt = now;
  state.lastStage = stage;
  if (state.pending) {
    clearTimeout(state.pending);
    state.pending = null;
  }
  await postSigned(req.callback_url, req.callback_secret, {
    stage,
    fraction: Math.min(1, fraction),
    counters: payloadCounters,
  });
  await pool.query(
    `UPDATE cluster_ingest_request SET last_progress_at = now() WHERE cluster_job_id = $1`,
    [req.cluster_job_id],
  );
}

/**
 * Mark a cluster ingest request as canceled. Runner consults this before each
 * per-doc job; emitter stops sending after this is set.
 */
export async function markCanceled(
  pool: Pool,
  clusterJobId: string,
): Promise<void> {
  await pool.query(
    `UPDATE cluster_ingest_request
        SET canceled = true,
            status = 'canceled',
            last_progress_at = now()
      WHERE cluster_job_id = $1`,
    [clusterJobId],
  );
  const s = emitters.get(clusterJobId);
  if (s) {
    s.finalized = true;
    if (s.pending) {
      clearTimeout(s.pending);
      s.pending = null;
    }
  }
}

export async function isCanceled(
  pool: Pool,
  ingestJobId: string,
): Promise<boolean> {
  const { rows } = await pool.query<{ canceled: boolean }>(
    `SELECT canceled FROM cluster_ingest_request WHERE ingest_job_id = $1`,
    [ingestJobId],
  );
  return rows[0]?.canceled === true;
}
