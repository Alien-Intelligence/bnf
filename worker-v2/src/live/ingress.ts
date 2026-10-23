/**
 * HTTP ingress — the app↔worker inbound seam (`POST /ingest`). Validates the
 * app's ClusterIngestRequest, opens an ingest_run (callback coords + target
 * version + app job id), and seeds the run's ARKs into the metadata bucket. The
 * returned runId IS the clusterJobId the app stores and polls.
 *
 * Self-contained on purpose (the dual-undici lesson): v2 re-resolves each doc's
 * metadata itself in the metadata stage, and lane routing, page count and OCR
 * rate stay manifest-authoritative. From the app's `added[]` it takes the ARK
 * plus `subtype` and `docType` (derived app-side from the OAI typedoc), which
 * are trusted for the INDEXED metadata only: they ride on the DocRef into the
 * metadata stage and make no BnF call. `removed[]` is ignored — removal is
 * committed app-side; v2 has no delete path.
 */
import { randomUUID } from "node:crypto";

import type { QueueClient } from "../core/types.js";
import type { DocStateStore } from "../domain/doc-state.js";
import type { RunStore } from "../domain/run.js";
import { Q } from "../domain/queues.js";
import type { DocRef } from "../domain/types.js";

export interface IngressDeps {
  runStore: RunStore;
  docState: DocStateStore;
  queue: QueueClient;
}

/** One `added[]` entry, reduced to what v2 consumes. */
export interface IngestDoc {
  ark: string;
  /** Gallica typedoc subcategory; null when the app has none. */
  subtype: string | null;
  /**
   * The app's document type, already normalized app-side (the boundary funnel,
   * unknown → "other"). Required: the app's ClusterDoc.docType is never null.
   */
  docType: string;
}

/** The fields v2 needs from the app's ClusterIngestRequest. */
export interface ParsedIngestRequest {
  projectId: string;
  targetVersionId: string;
  appJobId: string;
  docs: IngestDoc[];
  callbackUrl: string;
  callbackSecret: string;
}

export interface IngressResult {
  runId: string;
  totalDocs: number;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/**
 * A nullable string field of an `added[]` entry: absent or null → null, a
 * non-blank string → itself. Anything else (a non-string, a blank string) is a
 * contract violation, reported by the caller as a 400 rather than coerced.
 */
function nullableString(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null };
  const s = asString(v);
  return s === null ? { ok: false } : { ok: true, value: s };
}

/**
 * Parse + validate the raw request body into the subset v2 consumes. Returns a
 * discriminated result so the HTTP handler maps a parse failure to a 400 with the
 * specific reason rather than a generic crash. Every required field is checked —
 * no empty defaults (platform CLAUDE_ERROR_PATTERNS §10).
 */
export function parseIngestRequest(
  raw: unknown,
): { ok: true; value: ParsedIngestRequest } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = raw as Record<string, unknown>;

  const projectId = asString(b.projectId);
  if (!projectId) return { ok: false, error: "projectId is required" };
  const targetVersionId = asString(b.targetVersionId);
  if (!targetVersionId) return { ok: false, error: "targetVersionId is required" };
  const appJobId = asString(b.appJobId);
  if (!appJobId) return { ok: false, error: "appJobId is required" };
  const callbackUrl = asString(b.callbackUrl);
  if (!callbackUrl) return { ok: false, error: "callbackUrl is required" };
  const callbackSecret = asString(b.callbackSecret);
  if (!callbackSecret) return { ok: false, error: "callbackSecret is required" };

  if (!Array.isArray(b.added)) return { ok: false, error: "added must be an array" };
  const docs: IngestDoc[] = [];
  for (const [i, entry] of b.added.entries()) {
    const doc = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const ark = doc ? asString(doc.ark) : null;
    if (!doc || !ark) return { ok: false, error: `added[${i}].ark is required` };
    const subtype = nullableString(doc.subtype);
    if (!subtype.ok) return { ok: false, error: `added[${i}].subtype must be a non-blank string or null` };
    const docType = asString(doc.docType);
    if (!docType) return { ok: false, error: `added[${i}].docType is required` };
    docs.push({ ark, subtype: subtype.value, docType });
  }

  return {
    ok: true,
    value: { projectId, targetVersionId, appJobId, docs, callbackUrl, callbackSecret },
  };
}

/**
 * Open a run and seed its docs' ARKs. Creates the ingest_run row first (so the callback
 * coordinates exist before any doc can complete and trigger a terminal emit), then
 * upserts one doc-state row per ARK and fans them onto the metadata bucket.
 *
 * An empty `docs` (a removal-only delta) creates a zero-doc run that completes
 * immediately — the caller emits its terminal event so the app commits the
 * removal. We never short-circuit it away here; the run row must exist for the
 * callback to fire.
 *
 * IDEMPOTENT ON appJobId (audit finding F19): the app is the only caller of
 * `POST /ingest`, and it has its own client-side timeout independent of
 * whether this call actually succeeded. If the app retries after a timeout
 * (or after never receiving our response for any other transport reason), a
 * second POST for the SAME appJobId must NOT open a second run and re-seed
 * the same ARKs a second time — it returns the run already open for that
 * job. This is checked first, before any run is created or any doc is
 * touched.
 */
export async function createRunAndSeed(
  deps: IngressDeps,
  req: ParsedIngestRequest,
): Promise<IngressResult> {
  const existing = await deps.runStore.getByAppJobId(req.appJobId);
  if (existing) {
    return { runId: existing.runId, totalDocs: existing.totalDocs };
  }

  const runId = randomUUID();
  const refs: DocRef[] = req.docs.map(({ ark, subtype, docType }) => ({
    projectId: req.projectId,
    docJobId: randomUUID(),
    ark,
    runId,
    subtype,
    docType,
  }));

  await deps.runStore.create({
    runId,
    appJobId: req.appJobId,
    projectId: req.projectId,
    callbackUrl: req.callbackUrl,
    callbackSecret: req.callbackSecret,
    targetVersionId: req.targetVersionId,
    totalDocs: refs.length,
  });

  // Batch-seed (F19): one multi-row insert (chunked at 1000 in the pg impl)
  // instead of N sequential awaits — for a large delta (465 docs in the
  // incident that motivated this slice) the sequential form could approach
  // the app's client timeout on its own.
  await deps.docState.upsertDocs(refs);
  if (refs.length > 0) await deps.queue.sendMany(Q.metadata, refs);

  return { runId, totalDocs: refs.length };
}
