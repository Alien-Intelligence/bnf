/**
 * Idempotent schema bootstrap for Track 2 tables.
 *
 * Reads src/queue/schema.sql and applies it. Safe to run on every worker boot.
 * pg-boss owns its own `pgboss` schema; we don't touch it.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schema.sql");

export const SANDBOX_SCHEMA = "sandbox_ingest";

export async function migrate(pool: Pool): Promise<void> {
  const sql = await readFile(SCHEMA_PATH, "utf8");
  await pool.query(sql);
}

/**
 * Apply `SET search_path = sandbox_ingest, public` to every connection
 * checked out of the pool, so the unqualified table names in repo.ts
 * resolve to the sandbox schema.
 */
export function installSearchPath(pool: Pool): void {
  pool.on("connect", (client) => {
    client
      .query(`SET search_path = ${SANDBOX_SCHEMA}, public`)
      .catch((err) => {
        console.error("[migrate] failed to set search_path:", err);
      });
  });
}
