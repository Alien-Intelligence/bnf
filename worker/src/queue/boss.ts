/**
 * Process-singleton pg-boss instance. One per worker process; one per CLI run.
 *
 * pg-boss creates and owns its own schema (`pgboss`) inside the DATABASE_URL
 * database. We share connection string with our app tables but stay out of its
 * schema.
 */

import PgBoss from "pg-boss";
import { db } from "../env.js";

let instance: PgBoss | null = null;
let startingPromise: Promise<PgBoss> | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (instance) return instance;
  if (startingPromise) return startingPromise;

  startingPromise = (async () => {
    const boss = new PgBoss({ connectionString: db.url() });
    boss.on("error", (err: Error) => {
      // pg-boss emits transient errors here; log and keep running.
      console.error("[pg-boss] error:", err.message);
    });
    await boss.start();
    instance = boss;
    return boss;
  })();

  try {
    return await startingPromise;
  } finally {
    startingPromise = null;
  }
}

export async function stopBoss(): Promise<void> {
  if (!instance) return;
  const boss = instance;
  instance = null;
  await boss.stop({ graceful: true, wait: true });
}
