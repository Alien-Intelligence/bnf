/**
 * Seed CLI — enqueue documents into the V2 pipeline head (the metadata bucket).
 * Creates a `document_ingest_job_v2` row per ARK and sends a DocRef onto the
 * metadata queue; the running worker (main.ts) picks them up. Kept transport-only
 * so it can run against the same pg-boss + Postgres the worker uses.
 *
 *   npx tsx src/seed.ts <projectId> <ark...>
 *
 * ARKs for the integration gates are pulled from the local app DB — see
 * RUN.md for the query that samples one ARK per lane (text / vision / mistral).
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { loadConfig } from "./config.js";
import { PgBossQueue } from "./core/queue-pgboss.js";
import { PgDocState } from "./domain/doc-state-pg.js";
import { Q } from "./domain/queues.js";
import type { DocRef } from "./domain/types.js";

async function main(): Promise<void> {
  const [projectId, ...arks] = process.argv.slice(2);
  if (!projectId || arks.length === 0) {
    console.error("usage: tsx src/seed.ts <projectId> <ark...>");
    process.exit(2);
  }

  const cfg = loadConfig();
  const queue = new PgBossQueue(cfg.databaseUrl);
  await queue.start();
  const pool = new Pool({ connectionString: cfg.databaseUrl });
  const docState = new PgDocState(pool);
  await docState.migrate();

  const refs: DocRef[] = arks.map((ark) => ({ projectId, docJobId: randomUUID(), ark }));
  for (const ref of refs) {
    await docState.upsertDoc(ref);
  }
  await queue.sendMany(Q.metadata, refs);
  console.log(`seeded ${refs.length} docs into ${Q.metadata} for project ${projectId}`);
  for (const r of refs) console.log(`  ${r.docJobId}  ${r.ark}`);

  await queue.stop();
  await pool.end();
}

main().catch((err) => {
  console.error("[seed] fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
