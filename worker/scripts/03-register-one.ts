/**
 * Smoke test for the full Track 3 upsert flow.
 *
 *   npm run register:one -- <projectId> <ARK>
 *
 * Reads the prepared-doc artifacts that Track 1 wrote to BlobStore
 * (doc.md, doc.json, chunks.jsonl), reconstructs a PreparedDoc in memory,
 * and runs `ensureDataset` + `upsert` against the data cluster.
 *
 * Requires:
 *   BLOB_STORE + (SCW_S3_* or LOCAL_BLOB_ROOT)
 *   RUNPOD_API_KEY, RUNPOD_EMBEDDING_ENDPOINT_ID
 *   BACKEND_API_URL, CLUSTER_ID, CLUSTER_BEARER_TOKEN
 */
import { getBlobStore } from "../src/blob/index.js";
import { BnfClusterSink } from "../src/cluster/upsert.js";
import { bnfDatasetSlug } from "../src/cluster/dataset.js";
import { docKeys } from "../src/slug.js";
import type {
  ChunkRow,
  DocMetadata,
  Pipeline,
  PreparedDoc,
} from "../src/types.js";

interface DocJson {
  metadata: DocMetadata;
  pipeline: Pipeline;
  contentHash: string;
}

function parseArgs(): { projectId: string; ark: string } {
  const [, , projectId, ark] = process.argv;
  if (!projectId || !ark) {
    console.error(
      "Usage: npm run register:one -- <projectId> <ARK>\n" +
        "  e.g. npm run register:one -- test-project ark:/12148/btv1b9015469h",
    );
    process.exit(2);
  }
  return { projectId, ark };
}

async function loadPreparedDoc(projectId: string, ark: string): Promise<PreparedDoc> {
  const blob = getBlobStore();
  const keys = docKeys(projectId, ark);

  const mdBuf = await blob.get(keys.docMd);
  if (!mdBuf) throw new Error(`Missing artifact: ${keys.docMd} — run Track 1 first.`);
  const jsonBuf = await blob.get(keys.docJson);
  if (!jsonBuf) throw new Error(`Missing artifact: ${keys.docJson}`);
  const chunksBuf = await blob.get(keys.chunksJsonl);
  if (!chunksBuf) throw new Error(`Missing artifact: ${keys.chunksJsonl}`);

  const markdown = mdBuf.toString("utf8");
  const docJson = JSON.parse(jsonBuf.toString("utf8")) as DocJson;
  const chunks: ChunkRow[] = chunksBuf
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line) as ChunkRow;
      } catch (err) {
        throw new Error(
          `chunks.jsonl line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : err}`,
        );
      }
    });

  return {
    projectId,
    pipeline: docJson.pipeline,
    metadata: docJson.metadata,
    markdown,
    chunks,
    contentHash: docJson.contentHash,
    blobKeys: keys,
  };
}

async function main(): Promise<void> {
  const { projectId, ark } = parseArgs();

  console.log(`Loading prepared doc from blob storage...`);
  console.log(`  projectId=${projectId} ark=${ark}`);
  const prepared = await loadPreparedDoc(projectId, ark);
  console.log(
    `  loaded: ${prepared.chunks.length} chunks, ${prepared.markdown.length} chars markdown, pipeline=${prepared.pipeline}`,
  );

  const sink = new BnfClusterSink();

  const datasetSlug = bnfDatasetSlug(projectId);
  console.log(`Ensuring dataset slug=${datasetSlug}...`);
  const { datasetId } = await sink.ensureDataset({
    projectId,
    name: `BnF — ${projectId}`,
    slug: datasetSlug,
  });
  console.log(`  datasetId=${datasetId}`);

  console.log(`Upserting entry for ${prepared.metadata.ark}...`);
  const result = await sink.upsert({ datasetId, prepared });

  console.log(`OK entryId=${result.entryId} chunksWritten=${result.chunksWritten}`);
  console.log(`   timings(ms) ${JSON.stringify(result.timings)}`);
}

main().catch((err) => {
  console.error("register:one failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
