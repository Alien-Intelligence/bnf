/**
 * One-shot CLI to submit an ingest job and poll for completion.
 *
 *   npm run queue:submit -- <projectId> <ARK> [<ARK> ...]
 *
 * Creates the parent `ingest_job` + N `document_ingest_job` rows, enqueues
 * one pg-boss job per child, and tails the parent's counts every 2s until
 * the run reaches a terminal state.
 */

import "./_loadenv.js";
import { Pool } from "pg";
import { db } from "../src/env.js";
import {
  IngestOrchestrator,
  Repo,
  getBoss,
  installSearchPath,
  migrate,
  stopBoss,
} from "../src/queue/index.js";

const POLL_INTERVAL_MS = 2000;

function parseArgs(): { projectId: string; arks: string[] } {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error(
      "Usage: npm run queue:submit -- <projectId> <ARK> [<ARK> ...]",
    );
    process.exit(2);
  }
  const [projectId, ...arks] = argv;
  if (!projectId || arks.length === 0) {
    console.error("projectId and at least one ARK are required");
    process.exit(2);
  }
  return { projectId, arks };
}

async function main(): Promise<void> {
  const { projectId, arks } = parseArgs();
  const pool = new Pool({ connectionString: db.url() });
  installSearchPath(pool);
  await migrate(pool);

  const repo = new Repo(pool);
  const boss = await getBoss();
  const orchestrator = new IngestOrchestrator(repo, boss);

  const { ingestJobId, documentIngestJobIds } = await orchestrator.submit({
    projectId,
    arks,
  });
  console.log(
    `[submit] ingestJobId=${ingestJobId} (${documentIngestJobIds.length} docs)`,
  );

  let stopRequested = false;
  process.once("SIGINT", () => {
    stopRequested = true;
    console.log("\n[submit] SIGINT — stopping poll (job continues in worker)");
  });

  // eslint-disable-next-line no-constant-condition
  while (!stopRequested) {
    const job = await repo.getIngestJob(ingestJobId);
    if (!job) {
      console.error("[submit] parent job vanished");
      break;
    }
    console.log(
      `[submit] status=${job.status} total=${job.totalDocs} ` +
        `done=${job.doneCount} failed=${job.failedCount} ` +
        `skipped=${job.skippedCount} chunks=${job.chunksWritten}`,
    );
    if (
      job.status === "done" ||
      job.status === "failed" ||
      job.status === "canceled"
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  await stopBoss();
  await pool.end();
}

main().catch((err) => {
  console.error("[submit] fatal:", err);
  process.exit(1);
});
