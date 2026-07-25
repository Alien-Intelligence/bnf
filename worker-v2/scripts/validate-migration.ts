/**
 * Phase 3 validation — compare per-dataset entry_count between the dev (158) and
 * prod (113) catalogs for the migrated real-project datasets, and prove the RAG
 * path works on prod with a live vector search.
 *
 * Run from datastreaming-demos/bnf/worker-v2:
 *   node --import tsx scripts/validate-migration.ts
 * (uses the same env as run-backfill.sh)
 */
import { readFileSync } from "node:fs";
import { ClusterHttp } from "../src/live/cluster-http.js";

function req(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`Missing ${n}`);
  return v;
}
const dev = new ClusterHttp({
  baseUrl: `${req("DEV_BACKEND_API_URL")}/clusters/${req("DEV_CLUSTER_ID")}/proxy`,
  bearerToken: req("DEV_CLUSTER_BEARER_TOKEN"), timeoutMs: 60_000, attempts: 4,
});
const prod = new ClusterHttp({
  baseUrl: `${req("PROD_BACKEND_API_URL")}/clusters/${req("PROD_CLUSTER_ID")}/proxy`,
  bearerToken: req("PROD_CLUSTER_BEARER_TOKEN"), timeoutMs: 60_000, attempts: 4,
});

interface DS { id: number; slug: string; entry_count?: number }
async function datasets(http: ClusterHttp): Promise<Map<string, DS>> {
  const out = new Map<string, DS>();
  for (let page = 1; page <= 200; page++) {
    const r = await http.getJson<{ datasets: DS[]; total_pages?: number }>(
      `/api/v1/datasets?page=${page}&page_size=100`);
    for (const d of r.datasets ?? []) out.set(d.slug, d);
    if (page >= (r.total_pages ?? 1)) break;
  }
  return out;
}

const allow = new Set<string>(
  (JSON.parse(readFileSync(req("PROJECT_ALLOWLIST_FILE"), "utf8")) as string[]).map((id) => `bnf-${id}`),
);

const devDs = await datasets(dev);
const prodDs = await datasets(prod);
const kept = [...devDs.values()].filter((d) => allow.has(d.slug)).sort((a, b) => a.id - b.id);

let devTotal = 0, prodTotal = 0, mismatches = 0;
console.log("slug".padEnd(46), "dev".padStart(6), "prod".padStart(6), " ok");
for (const d of kept) {
  const p = prodDs.get(d.slug);
  const dc = d.entry_count ?? 0, pc = p?.entry_count ?? 0;
  devTotal += dc; prodTotal += pc;
  const ok = pc === dc;
  if (!ok) mismatches++;
  console.log(d.slug.padEnd(46), String(dc).padStart(6), String(pc).padStart(6), ok ? " ✓" : ` ✗ (${pc - dc})`);
}
console.log("-".repeat(66));
console.log(`TOTAL dev=${devTotal} prod=${prodTotal} datasets=${kept.length} mismatches=${mismatches}`);

// RAG proof: a live vector search on the largest prod dataset.
const big = kept.reduce((a, b) => ((b.entry_count ?? 0) > (a.entry_count ?? 0) ? b : a), kept[0]!);
const bigProd = prodDs.get(big.slug)!;
try {
  const res = await prod.postJson<{ results?: Array<{ metadata?: Record<string, unknown>; score?: number }> }>(
    "/api/v1/search/vector",
    { query: "mode et vêtements", dataset_ids: [bigProd.id], limit: 3 },
  );
  const hits = res.results ?? [];
  console.log(`\nRAG vector search on ${big.slug} (prod id ${bigProd.id}): ${hits.length} hits`);
  for (const h of hits.slice(0, 3)) {
    console.log("  ark=", h.metadata?.ark, "folio=", h.metadata?.folio, "score=", h.score);
  }
} catch (e) {
  console.log("\nRAG vector search endpoint probe failed (may differ):", e instanceof Error ? e.message : String(e));
  console.log("→ verify RAG via the datacluster MCP tool instead at cutover.");
}
