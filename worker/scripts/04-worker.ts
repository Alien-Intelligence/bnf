/**
 * Long-running ingest worker.
 *
 *  - Ensures the Track-2 schema is present.
 *  - Starts pg-boss.
 *  - Composes the DocumentIngestRunner with Track 1 + Track 3 implementations.
 *    For this sandbox we use the stubs in `./_stubs.ts`. When the real impls
 *    land, swap the two `new Stub*` lines for the real classes.
 *  - Consumes the `bnf.ingest.doc` queue with the configured concurrency.
 *  - Drains gracefully on SIGINT/SIGTERM.
 */

import "./_loadenv.js";
import { Pool } from "pg";
import { db } from "../src/env.js";
import { bnfDatasetSlug, getClusterSink } from "../src/cluster/index.js";
import { createPreparePipeline } from "../src/prepare/index.js";
import {
  DOC_QUEUE_NAME,
  DocumentIngestRunner,
  getBoss,
  installSearchPath,
  migrate,
  Repo,
  stopBoss,
  type DocJobQueuePayload,
} from "../src/queue/index.js";

const CONCURRENCY = Math.max(
  1,
  parseInt(process.env.WORKER_CONCURRENCY ?? "4", 10),
);

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: db.url() });
  installSearchPath(pool);
  await migrate(pool);
  console.log("[worker] schema migrated");

  const repo = new Repo(pool);
  const boss = await getBoss();
  await boss.createQueue(DOC_QUEUE_NAME).catch(() => undefined);
  console.log(`[worker] pg-boss started, queue '${DOC_QUEUE_NAME}' ready`);

  // ---- Composition root: real Track 1 + Track 3 implementations. ----
  const docPipeline = createPreparePipeline({
    maxImageCanvases: process.env.MAX_IMAGE_CANVASES
      ? parseInt(process.env.MAX_IMAGE_CANVASES, 10)
      : undefined,
    imageConcurrency: process.env.IMAGE_CONCURRENCY
      ? parseInt(process.env.IMAGE_CONCURRENCY, 10)
      : undefined,
  });
  const clusterSink = getClusterSink();
  // Per-project dataset cache so we don't round-trip the cluster on every job.
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
    console.log(`[worker] dataset for ${projectId}: id=${datasetId}`);
    return datasetId;
  };
  // -----------------------------------------------------------------

  const runner = new DocumentIngestRunner(
    docPipeline,
    clusterSink,
    resolveDatasetId,
    repo,
  );

  await boss.work<DocJobQueuePayload>(
    DOC_QUEUE_NAME,
    { batchSize: CONCURRENCY, pollingIntervalSeconds: 1 },
    async (jobs) => {
      // Post-Pass-2, the runner rethrows TransientBnfError so pg-boss's
      // retryLimit/retryDelay/retryBackoff can fire. Letting the throw bubble
      // out of THIS handler would fail the whole batch, so per-job: catch +
      // call boss.fail() to mark only the failing job for retry. Jobs that
      // resolve normally are implicitly completed by pg-boss.
      await Promise.all(
        jobs.map(async (job) => {
          try {
            await runner.run(job.data.docJobId);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(
              `[worker] runner threw for doc=${job.data.docJobId} job=${job.id}; marking for retry: ${message}`,
            );
            await boss
              .fail(DOC_QUEUE_NAME, job.id, { error: message })
              .catch((failErr) =>
                console.error("[worker] boss.fail() itself failed:", failErr),
              );
          }
        }),
      );
    },
  );
  console.log(
    `[worker] consuming '${DOC_QUEUE_NAME}' with concurrency=${CONCURRENCY}`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] ${signal} received — draining`);
    try {
      await stopBoss();
    } catch (err) {
      console.error("[worker] error stopping pg-boss:", err);
    }
    try {
      await pool.end();
    } catch (err) {
      console.error("[worker] error closing pool:", err);
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
