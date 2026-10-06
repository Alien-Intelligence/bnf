// lib/db.test.ts
// The app's pool bounds every statement server-side: a hung query fails at
// DB_STATEMENT_TIMEOUT_MS instead of wedging its caller (and every overlap
// guard it holds) for the process lifetime.
import "server-only"

import { after, test } from "node:test"
import assert from "node:assert/strict"
import { DB_STATEMENT_TIMEOUT_MS } from "@/lib/constants"
import { prisma } from "@/lib/db"

after(async () => {
  await prisma.$disconnect()
})

test("every pooled connection carries the statement timeout", async () => {
  const rows = await prisma.$queryRaw<Array<{ ms: number }>>`
    SELECT EXTRACT(EPOCH FROM current_setting('statement_timeout')::interval) * 1000 AS ms`
  assert.equal(Number(rows[0].ms), DB_STATEMENT_TIMEOUT_MS)
})
