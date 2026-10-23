// tests/models/bnf-records/seed-migration.test.ts
// The one-time seed in migration 20261022110646_bnf_record_cache copies the
// previous release's raw_metadata into bnf_record. Rows from that release carry
// OCR verdict keys without `ocr_source`; the seed must turn each into a clean
// STAGED entry. The SELECT under test is read out of the migration file, so
// this test cannot drift from it. Everything runs in a transaction that is
// rolled back; the shared database is never migrated or left modified.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { prisma } from "@/lib/db"
import type { Prisma } from "@/lib/generated/prisma/client"

const MIGRATION = path.join(process.cwd(), "prisma/migrations/20261022110646_bnf_record_cache/migration.sql")
const FASCICULE = "ark:/12148/bpt6k9600001"
const MONOGRAPH = "ark:/12148/bpt6k9600002"
const MANIFEST_ONLY = "ark:/12148/bpt6k9600003"

class Rollback extends Error {}

/** The seed's SELECT, extracted from the INSERT ... SELECT in the migration. */
function seedSelect(): string {
  const sql = readFileSync(MIGRATION, "utf8")
  const match = /INSERT INTO "bnf_record" \([^)]*\)\s*(SELECT[\s\S]*?);/.exec(sql)
  assert.ok(match, "migration no longer contains the INSERT ... SELECT seed")
  return match[1]
}

test("the seed stages a clean entry: verdict keys removed, mode texte kept, OAI count carried", async () => {
  const seeded = new Map<string, Record<string, unknown>>()
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      const userId = randomUUID()
      await tx.user.create({ data: { id: userId, email: `seed-${userId}@bnf-unit.local`, name: "seed", emailVerified: true } })
      const project = await tx.project.create({ data: { ownerId: userId, name: "TEST seed migration" } })
      const resolved = (ark: string, rawMetadata: Prisma.InputJsonObject) =>
        tx.document.create({
          data: { ark, projectId: project.id, resolveStatus: "resolved", resolvedAt: new Date(), rawMetadata },
        })
      await resolved(FASCICULE, {
        title: "Journal",
        gallica_typedoc: "fascicules",
        ocr_available: false,
        pages: 13027,
        pages_source: "oai",
        taux_ocr: 0.97,
      })
      await resolved(MONOGRAPH, {
        title: "Livre",
        gallica_typedoc: "monographies",
        ocr_available: true,
        ocr_source: "oai",
        pages: 71,
      })
      await resolved(MANIFEST_ONLY, { title: "Sans OAI", pages: 5 })

      const rows = await tx.$queryRawUnsafe<{ ark: string; payload: Record<string, unknown>; source: string }[]>(
        `SELECT "ark", "payload", "source" FROM (${seedSelect()}) AS seed WHERE "ark" = ANY($1::text[])`,
        [FASCICULE, MONOGRAPH, MANIFEST_ONLY],
      )
      for (const row of rows) {
        assert.equal(row.source, "oai_gallica")
        seeded.set(row.ark, row.payload)
      }
      throw new Rollback()
    }),
    Rollback,
  )

  assert.deepEqual(seeded.get(FASCICULE), {
    title: "Journal",
    gallica_typedoc: "fascicules",
    oai_total_views: 13027,
  })
  assert.deepEqual(seeded.get(MONOGRAPH), {
    title: "Livre",
    gallica_typedoc: "monographies",
    ocr_available: true,
    oai_total_views: 71,
  })
  assert.equal(seeded.has(MANIFEST_ONLY), false, "a row without OAI provenance is not seeded")
  assert.equal(await prisma.document.count({ where: { ark: { in: [FASCICULE, MONOGRAPH, MANIFEST_ONLY] } } }), 0)
})
