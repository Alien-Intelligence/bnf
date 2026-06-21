/**
 * CLI: prepare one BnF document end-to-end.
 *
 *   npm run prepare:one -- <projectId> <ARK>
 *
 * Exits:
 *   0 — PreparedDoc returned (persisted to BlobStore)
 *   1 — typed skip
 *   2 — uncaught error
 */
// Load .env if present (Node ≥ 20.12 ships process.loadEnvFile).
// We declare the method's shape locally because the @types/node version pinned
// in this sandbox doesn't yet expose it on NodeJS.Process.
interface ProcessWithEnvFile {
  loadEnvFile?: (path?: string) => void;
}
const proc: ProcessWithEnvFile = process;
if (typeof proc.loadEnvFile === "function") {
  try {
    proc.loadEnvFile(".env");
  } catch {
    // No .env — env vars are expected to be set externally.
  }
}

import { createPreparePipeline } from "../src/prepare/index.js";
import type { PreparedDoc, SkipReason } from "../src/types.js";

function usage(): never {
  console.error("Usage: npm run prepare:one -- <projectId> <ARK>");
  process.exit(2);
}

async function main(): Promise<void> {
  const [, , projectId, ark] = process.argv;
  if (!projectId || !ark) usage();

  if (!ark!.startsWith("ark:/12148/")) {
    console.error(`ARK must be canonical "ark:/12148/<id>", got: ${ark}`);
    process.exit(2);
  }

  console.log(`[prepare:one] projectId=${projectId} ark=${ark}`);

  const maxImageCanvases = process.env.MAX_IMAGE_CANVASES
    ? parseInt(process.env.MAX_IMAGE_CANVASES, 10)
    : undefined;
  const pipeline = createPreparePipeline({ maxImageCanvases });
  const t0 = Date.now();
  let result: PreparedDoc | SkipReason;
  try {
    result = await pipeline.prepare({ projectId: projectId!, ark: ark! });
  } catch (e) {
    console.error("[prepare:one] uncaught error:", e);
    process.exit(2);
  }
  const elapsed = Date.now() - t0;

  if ("skip" in result && result.skip === true) {
    console.log(`[prepare:one] SKIP (${elapsed} ms): ${result.reason}`);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const ok = result as PreparedDoc;
  console.log(`[prepare:one] OK (${elapsed} ms)`);
  console.log(`  pipeline:    ${ok.pipeline}`);
  console.log(`  chunks:      ${ok.chunks.length}`);
  console.log(`  contentHash: ${ok.contentHash}`);
  console.log(`  blobKeys:`);
  console.log(`    doc.md       ${ok.blobKeys.docMd}`);
  console.log(`    doc.json     ${ok.blobKeys.docJson}`);
  console.log(`    chunks.jsonl ${ok.blobKeys.chunksJsonl}`);

  const first = ok.chunks[0];
  if (first) {
    console.log(`\n  --- chunk[0] (chars ${first.charStart}..${first.charEnd}) ---`);
    console.log(`  metadata: ${JSON.stringify(first.metadata)}`);
    console.log(`  text:     ${first.text.slice(0, 200)}${first.text.length > 200 ? "…" : ""}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("[prepare:one] fatal:", e);
  process.exit(2);
});
