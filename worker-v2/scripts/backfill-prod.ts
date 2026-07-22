/**
 * BnF prod-data migration — S3-replay backfill driver.
 *
 * Re-registers the already-prepared+embedded corpus from the shared Scaleway
 * Object Storage backup (`bnf-corpus-demo`, prefix `v2/`) into a FRESH prod
 * data-cluster tenant, WITHOUT re-OCR / re-embed / re-vision. It replays exactly
 * what the worker's register stage does (`LiveClusterSink.upsert`): create entry
 * → upload doc.md → save processed text → index one chunk per page with its
 * precomputed embedding (ark + folio in chunk metadata → citations survive).
 *
 * WHY a bespoke driver and not the worker itself:
 *  - The worker registers only what its pg-boss queue currently holds; we need a
 *    full, catalog-driven replay of every historical doc.
 *  - `LiveClusterSink.upsert` calls `findEntryBySlug`, which paginates the whole
 *    dataset PER DOC → O(n²) on the big datasets (3922 / 2910 entries). We reuse
 *    its proven *pure* helpers (assembleMarkdown / buildIndexChunks) and the
 *    vendored ClusterHttp transport, but preload each dataset's existing-entry
 *    map ONCE (also what makes re-runs crash-safe and delta-cheap).
 *
 * Source of truth:
 *  - Manifest (which ark belongs to which project/dataset, + change signal):
 *    the DEV data-cluster catalog (healthy) via the platform proxy on cluster 158.
 *  - Artifacts (pages text + embeddings + resolved meta): dev S3 `v2/` blobs.
 *  - Which datasets are REAL (not test/orphan corpora): the app's project id set
 *    (PROJECT_ALLOWLIST_FILE) — only datasets whose slug is `bnf-<projectId>`
 *    for a live app project are migrated.
 *
 * Idempotent / resumable / delta-aware:
 *  - A local STATE_FILE records, per (datasetSlug, ark), the dev change-signal
 *    (entry updated_at) and the prod entry id.
 *  - A doc is SKIPPED when its signal is unchanged AND it already exists in prod;
 *    otherwise it is (re)upserted (tombstoning the stale prod entry first — the
 *    cluster DELETE cascades MinIO + Qdrant + Meilisearch).
 *  - Run it now for the bulk; re-run at cutover for the delta; the second pass
 *    only touches docs added/changed since the first.
 *
 * Modes (env):
 *  - DRY_RUN=1        → build the manifest and print the plan; no writes.
 *  - ONLY_SLUG=<slug> → restrict to one dataset (single-dataset live test first).
 *  - PRUNE_ORPHANS=1  → (cutover only) tombstone prod entries whose ark is no
 *                       longer in the dev manifest (handles user deletions).
 *
 * Run (from datastreaming-demos/bnf/worker-v2):
 *   node --import tsx scripts/backfill-prod.ts
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

import { FormData } from "undici";

import { S3BlobStore } from "../src/core/blob.js";
import { keys, arkSlug } from "../src/domain/keys.js";
import { ClusterHttp } from "../src/live/cluster-http.js";
import { assembleMarkdown, buildIndexChunks, type IndexChunk } from "../src/live/cluster.js";
import { bnfDatasetSchema } from "../src/live/vendor/dataset.js";
import type { DocMeta, PreparedPage } from "../src/domain/types.js";
import type { BnfDocInfo } from "../src/bnf/types.js";

// ---------------------------------------------------------------------------
// Config (all from env; each required var throws by name — no silent defaults).
// ---------------------------------------------------------------------------
function required(name: string): string {
  const v = process.env[name];
  if (v == null || v.trim() === "") throw new Error(`Missing required env var ${name}`);
  return v.trim();
}
function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v == null || v.trim() === "" ? fallback : v.trim();
}

const DEV_BASE = `${required("DEV_BACKEND_API_URL").replace(/\/+$/, "")}/clusters/${required("DEV_CLUSTER_ID")}/proxy`;
const PROD_BASE = `${required("PROD_BACKEND_API_URL").replace(/\/+$/, "")}/clusters/${required("PROD_CLUSTER_ID")}/proxy`;

const STATE_FILE = optional("STATE_FILE", "backfill-state.json");
const ALLOWLIST_FILE = required("PROJECT_ALLOWLIST_FILE");
const CONCURRENCY = Number(optional("CONCURRENCY", "8"));
const DRY_RUN = optional("DRY_RUN", "") === "1";
const ONLY_SLUG = optional("ONLY_SLUG", "");
const PRUNE_ORPHANS = optional("PRUNE_ORPHANS", "") === "1";

const devHttp = new ClusterHttp({
  baseUrl: DEV_BASE,
  bearerToken: required("DEV_CLUSTER_BEARER_TOKEN"),
  timeoutMs: 60_000,
  attempts: 4,
});
const prodHttp = new ClusterHttp({
  baseUrl: PROD_BASE,
  bearerToken: required("PROD_CLUSTER_BEARER_TOKEN"),
  timeoutMs: 120_000, // big docs push multi-MB chunk bodies
  attempts: 4,
});
const s3Common = {
  bucket: required("SCW_S3_BUCKET"),
  endpoint: required("SCW_S3_ENDPOINT_URL"),
  region: required("SCW_S3_REGION"),
  accessKeyId: required("SCW_S3_ACCESS_KEY"),
  secretAccessKey: required("SCW_S3_SECRET_KEY"),
};
// V2 artifacts live under the `v2/` prefix; V1 (legacy) artifacts live under
// full keys `projects/<projectId>/docs/<arkSlug>/…`, so we need a prefix-less
// reader for the fallback path.
const blob = new S3BlobStore({ ...s3Common, prefix: optional("V2_S3_PREFIX", "v2/") });
const blobRoot = new S3BlobStore({ ...s3Common, prefix: "" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface DatasetView {
  id: number;
  slug: string;
  entry_count?: number;
}
interface EntryView {
  id: number;
  name: string; // the ARK
  slug: string; // arkSlug
  updated_at?: string;
  created_at?: string;
  version?: number;
}
interface EmbeddingsBlob {
  dim: number;
  vectors: number[][];
}
// --- Legacy (V1) blob shapes: projects/<projectId>/docs/<arkSlug>/… ---
interface V1DocJson {
  metadata: {
    ark: string;
    title: string | null;
    creator: string | null;
    date: string | null;
    docType: string | null;
    subtype: string | null;
    lang: string | null;
    pageCount: number | null;
    ocrAvailable: boolean;
  };
}
interface V1Chunk {
  chunkIndex: number;
  text: string;
  charStart: number;
  charEnd: number;
  metadata?: { ark?: string; arkSlug?: string; docType?: string | null };
}
interface V1Vectors {
  vectors: number[][];
}
/** A doc reduced to the exact inputs the cluster upsert needs. */
interface LoadedDoc {
  markdown: string;
  chunks: IndexChunk[];
  meta: DocMeta;
}
interface StateEntry {
  sig: string;
  prodEntryId: number;
}
interface State {
  version: 1;
  done: Record<string, StateEntry>; // key = `${datasetSlug}|${ark}`
}
interface ManifestItem {
  projectId: string;
  datasetSlug: string;
  ark: string;
  arkSlug: string;
  sig: string;
}

// ---------------------------------------------------------------------------
// State file (atomic write)
// ---------------------------------------------------------------------------
function loadState(): State {
  if (!existsSync(STATE_FILE)) return { version: 1, done: {} };
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
}
let state = loadState();
let dirtyCount = 0;
function saveState(): void {
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf8");
  renameSync(tmp, STATE_FILE);
  dirtyCount = 0;
}

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------
async function listDatasets(http: ClusterHttp): Promise<DatasetView[]> {
  const out: DatasetView[] = [];
  for (let page = 1; page <= 200; page++) {
    const res = await http.getJson<{ datasets: DatasetView[]; total_pages?: number }>(
      `/api/v1/datasets?page=${page}&page_size=100`,
    );
    out.push(...(res.datasets ?? []));
    if (page >= (res.total_pages ?? 1)) break;
  }
  return out;
}
async function listEntries(http: ClusterHttp, datasetId: number): Promise<EntryView[]> {
  const out: EntryView[] = [];
  for (let page = 1; page <= 1000; page++) {
    const res = await http.getJson<{ entries: EntryView[]; total_pages?: number }>(
      `/api/v1/entries?dataset_id=${datasetId}&page=${page}&page_size=100`,
    );
    out.push(...(res.entries ?? []));
    if (page >= (res.total_pages ?? 1)) break;
  }
  return out;
}
function sigOf(e: EntryView): string {
  return e.updated_at ?? e.created_at ?? (e.version != null ? `v${e.version}` : "0");
}

// ---------------------------------------------------------------------------
// Prod write path — faithful copy of LiveClusterSink.upsert's REST sequence,
// minus the internal per-doc find (existence is resolved from a preloaded map).
// ---------------------------------------------------------------------------
async function ensureProdDataset(projectId: string): Promise<number> {
  const slug = `bnf-${projectId}`;
  const existing = await prodHttp.getJsonOrNull<DatasetView>(
    `/api/v1/datasets/slug/${encodeURIComponent(slug)}`,
  );
  if (existing) return existing.id;
  const created = await prodHttp.postJson<DatasetView>("/api/v1/datasets", {
    name: `BnF ${projectId}`,
    slug,
    description: `BnF corpus dataset for project ${projectId}`,
    dataset_type: "text",
    schema_definition: bnfDatasetSchema(projectId),
  });
  return created.id;
}

async function createEntry(input: Record<string, unknown>): Promise<{ id: number }> {
  const res = await prodHttp.postJson<{ entry?: { id: number }; id?: number }>(
    "/api/v1/entries",
    input,
  );
  if (res && typeof res === "object" && "entry" in res && res.entry) return res.entry;
  if (res && typeof res === "object" && typeof res.id === "number") return res as { id: number };
  throw new Error(`createEntry: unexpected response ${JSON.stringify(res).slice(0, 200)}`);
}

async function uploadOriginal(entryId: number, filename: string, bytes: Buffer): Promise<void> {
  const formFactory = (): FormData => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), filename);
    form.set("file_type", "original");
    return form;
  };
  await prodHttp.postForm(`/api/v1/entries/${entryId}/upload`, formFactory);
}

/** Replay one already-loaded doc into prod. Returns the new prod entry id. */
async function upsertDoc(
  datasetId: number,
  ark: string,
  doc: LoadedDoc,
  staleProdEntryId: number | null,
): Promise<number> {
  const slug = arkSlug(ark);
  if (staleProdEntryId != null) await prodHttp.deleteJson(`/api/v1/entries/${staleProdEntryId}`);

  const { markdown, chunks, meta } = doc;
  const entry = await createEntry({
    dataset_id: datasetId,
    name: ark, // ARK is the entry identity (always < 255)
    slug,
    description: markdown.slice(0, 200),
    metadata: {
      ark,
      arkSlug: slug,
      title: meta.title,
      creator: meta.creator,
      date: meta.date,
      docType: meta.docType,
      subtype: meta.subtype,
      lang: meta.lang,
      source: "gallica",
      pageCount: meta.pageCount,
      ocrAvailable: meta.ocrAvailable,
    },
  });
  await uploadOriginal(entry.id, "doc.md", Buffer.from(markdown, "utf8"));
  await prodHttp.postJson(`/api/v1/entries/${entry.id}/processed`, { content: { text: markdown } });
  await prodHttp.postJson(`/api/v1/entries/${entry.id}/chunks`, {
    chunks,
    collection_name: "entry_chunks",
  });
  return entry.id;
}

// ---------------------------------------------------------------------------
// Artifact loading (S3)
// ---------------------------------------------------------------------------
function metaFromInfo(info: BnfDocInfo | null, pageFallback: number): DocMeta {
  if (!info) {
    // Defensive: pages+embeddings are the citation-critical inputs; meta only
    // affects keyword-hit display + facet filters. Never fabricate values.
    return {
      title: null, creator: null, date: null, docType: null,
      subtype: null, lang: null, pageCount: pageFallback, ocrAvailable: true,
    };
  }
  return {
    title: info.title, creator: info.creator, date: info.date, docType: info.docType,
    subtype: info.subtype, lang: info.lang, pageCount: info.pageCount, ocrAvailable: info.ocrAvailable,
  };
}

/** V2 path: pages + embeddings under `v2/`; one chunk per page (folio citations). */
async function loadV2(ark: string): Promise<LoadedDoc | null> {
  const pages = await blob.getJson<PreparedPage[]>(keys.pages(ark));
  const emb = await blob.getJson<EmbeddingsBlob>(keys.embeddings(ark));
  if (!pages || !emb) return null;
  if (pages.length !== emb.vectors.length) {
    throw new Error(`v2 page/vector misalignment for ${ark}: ${pages.length} vs ${emb.vectors.length}`);
  }
  const info = await blob.getJson<BnfDocInfo>(keys.metadata(ark));
  const meta = metaFromInfo(info, pages.length);
  return { markdown: assembleMarkdown(pages), chunks: buildIndexChunks(ark, meta, pages, emb.vectors), meta };
}

/** V1 (legacy) path: projects/<projectId>/docs/<arkSlug>/{doc.json,doc.md,chunks.jsonl,vectors.json}.
 *  Char-range chunks (no folio) — replayed as-is to preserve exact prior fidelity. */
async function loadV1(projectId: string, ark: string): Promise<LoadedDoc | null> {
  const dir = `projects/${projectId}/docs/${arkSlug(ark)}`;
  const docJson = await blobRoot.getJson<V1DocJson>(`${dir}/doc.json`);
  const vectorsBlob = await blobRoot.getJson<V1Vectors>(`${dir}/vectors.json`);
  const mdBytes = await blobRoot.getBytes(`${dir}/doc.md`);
  const chunksRaw = await blobRoot.getBytes(`${dir}/chunks.jsonl`);
  if (!docJson || !vectorsBlob || !mdBytes || !chunksRaw) return null;

  const v1Chunks = chunksRaw
    .toString("utf8")
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as V1Chunk);
  const vectors = vectorsBlob.vectors;
  if (v1Chunks.length !== vectors.length) {
    throw new Error(`v1 chunk/vector misalignment for ${ark}: ${v1Chunks.length} vs ${vectors.length}`);
  }

  const m = docJson.metadata;
  const meta: DocMeta = {
    title: m.title, creator: m.creator, date: m.date, docType: m.docType,
    subtype: m.subtype ?? null, lang: m.lang, pageCount: m.pageCount, ocrAvailable: m.ocrAvailable,
  };
  const slug = arkSlug(ark);
  const chunks: IndexChunk[] = v1Chunks.map((c, i) => ({
    chunk_text: c.text,
    chunk_index: c.chunkIndex ?? i,
    embedding: vectors[i]!,
    metadata: {
      ark,
      ark_slug: slug,
      doc_type: c.metadata?.docType ?? meta.docType ?? null,
      sub_type: meta.subtype,
      folio: null, // V1 chunked by char-range, not folio
      char_start: c.charStart,
      char_end: c.charEnd,
    },
  }));
  return { markdown: mdBytes.toString("utf8"), chunks, meta };
}

/** Load a doc's replay inputs: V2 layout first, then the legacy V1 layout. */
async function loadArtifacts(projectId: string, ark: string): Promise<LoadedDoc | null> {
  return (await loadV2(ark)) ?? (await loadV1(projectId, ark));
}

// ---------------------------------------------------------------------------
// Bounded-concurrency pool
// ---------------------------------------------------------------------------
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const totals = { datasets: 0, migrated: 0, skipped: 0, failed: 0, orphansPruned: 0, missingArtifacts: 0 };

async function main(): Promise<void> {
  const allowlist = new Set<string>(
    (JSON.parse(readFileSync(ALLOWLIST_FILE, "utf8")) as string[]).map((id) => `bnf-${id}`),
  );

  const allDatasets = await listDatasets(devHttp);
  let datasets = allDatasets.filter((d) => allowlist.has(d.slug));
  if (ONLY_SLUG) datasets = datasets.filter((d) => d.slug === ONLY_SLUG);
  datasets.sort((a, b) => a.id - b.id); // ascending dev id → tidy prod id order

  const skippedTest = allDatasets.length - datasets.length;
  console.log(
    `[manifest] dev datasets=${allDatasets.length} kept=${datasets.length} ` +
      `(excluded ${skippedTest} test/orphan) mode=${DRY_RUN ? "DRY_RUN" : "LIVE"}` +
      `${ONLY_SLUG ? ` ONLY=${ONLY_SLUG}` : ""}${PRUNE_ORPHANS ? " PRUNE_ORPHANS" : ""}`,
  );

  for (const ds of datasets) {
    const projectId = ds.slug.replace(/^bnf-/, "");
    const devEntries = await listEntries(devHttp, ds.id);
    // ARK derivation: the V2 sink sets name=ARK, but legacy/V1-ingested entries
    // set name=title with the arkSlug in `slug`. Reconstruct the ARK from the
    // slug in that case (Gallica arks are [a-z0-9], so arkSlug is loss-free →
    // `ark:/12148/<slug>`). Never drop an entry silently.
    const manifest: ManifestItem[] = devEntries
      .map((e) => {
        const name = String(e.name ?? "");
        const slug = String(e.slug ?? "");
        const ark = name.startsWith("ark:/") ? name : slug ? `ark:/12148/${slug}` : "";
        return { projectId, datasetSlug: ds.slug, ark, arkSlug: arkSlug(ark), sig: sigOf(e) };
      })
      .filter((m) => m.ark !== "");

    if (DRY_RUN) {
      console.log(`[dry] ${ds.slug} (dev id ${ds.id}): ${manifest.length} entries`);
      totals.datasets++;
      totals.migrated += manifest.length;
      continue;
    }

    const prodDatasetId = await ensureProdDataset(projectId);
    // Preload existing prod entries ONCE (crash-safe + delta-cheap; avoids the
    // O(n²) per-doc find in LiveClusterSink).
    const prodExisting = new Map<string, number>();
    for (const e of await listEntries(prodHttp, prodDatasetId)) prodExisting.set(e.slug, e.id);

    const devArkSlugs = new Set(manifest.map((m) => m.arkSlug));
    let dsMigrated = 0, dsSkipped = 0, dsFailed = 0;

    await pool(manifest, CONCURRENCY, async (m) => {
      const key = `${m.datasetSlug}|${m.ark}`;
      const prev = state.done[key];
      const existingId = prodExisting.get(m.arkSlug) ?? null;
      if (prev && prev.sig === m.sig && existingId != null) {
        dsSkipped++; totals.skipped++;
        return;
      }
      try {
        const art = await loadArtifacts(m.projectId, m.ark);
        if (!art) {
          console.warn(`[miss] ${m.ark}: no artifacts in S3 (v2/ or projects/) — skipping`);
          totals.missingArtifacts++; dsFailed++; totals.failed++;
          return;
        }
        const newId = await upsertDoc(prodDatasetId, m.ark, art, existingId);
        state.done[key] = { sig: m.sig, prodEntryId: newId };
        prodExisting.set(m.arkSlug, newId);
        dsMigrated++; totals.migrated++;
        if (++dirtyCount >= 25) saveState();
      } catch (e) {
        console.error(`[fail] ${m.ark}: ${e instanceof Error ? e.message : String(e)}`);
        dsFailed++; totals.failed++;
      }
    });

    // Cutover-only: remove prod entries the user deleted in dev since last run.
    if (PRUNE_ORPHANS) {
      for (const [slug, id] of prodExisting) {
        if (!devArkSlugs.has(slug)) {
          try {
            await prodHttp.deleteJson(`/api/v1/entries/${id}`);
            delete state.done[`${ds.slug}|ark:/12148/${slug}`]; // best-effort
            totals.orphansPruned++;
          } catch (e) {
            console.error(`[prune-fail] ${slug}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }

    saveState();
    totals.datasets++;
    console.log(
      `[done] ${ds.slug} (prod id ${prodDatasetId}): dev=${manifest.length} ` +
        `migrated=${dsMigrated} skipped=${dsSkipped} failed=${dsFailed}`,
    );
  }

  saveState();
  console.log("\n==================== SUMMARY ====================");
  console.log(JSON.stringify(totals, null, 2));
  if (totals.failed > 0) {
    console.log("\n⚠️  Some docs failed — re-run to retry (idempotent).");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  saveState();
  console.error("FATAL:", e);
  process.exit(1);
});
