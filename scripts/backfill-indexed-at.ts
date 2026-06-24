/**
 * One-off backfill for the new Document.indexedAt / indexError columns.
 *
 * Seeds per-doc index state from existing history so the delta is correct
 * immediately (without re-ingesting): a doc is "indexed" if it's in the last
 * ingested version OR was successfully added by any past job (added ∖ errors)
 * and not since removed. Failed-and-not-reindexed docs get their indexError.
 *
 * Idempotent. Run once after the migration:
 *   npx tsx --env-file-if-exists .env.local --conditions react-server scripts/backfill-indexed-at.ts
 */
import { prisma } from "@/lib/db"

void (async () => {
  const now = new Date()
  const projects = await prisma.project.findMany({
    select: { id: true, ingestedVersionId: true },
  })
  console.log(`backfill: ${projects.length} project(s)`)

  for (const p of projects) {
    const indexed = new Set<string>()
    const errReason = new Map<string, string>()

    if (p.ingestedVersionId) {
      const mem = await prisma.corpusMembership.findMany({
        where: { versionId: p.ingestedVersionId },
        select: { ark: true },
      })
      for (const m of mem) indexed.add(m.ark)
    }

    const jobs = await prisma.ingestJob.findMany({
      where: { projectId: p.id },
      select: { addedArks: true, removedArks: true, stats: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    })
    for (const j of jobs) {
      const failset = new Set<string>()
      const errs = (j.stats as { errors?: unknown } | null)?.errors
      if (Array.isArray(errs)) {
        for (const e of errs) {
          const ark = (e as { ark?: unknown })?.ark
          if (typeof ark === "string") {
            failset.add(ark)
            const r = e as { reason?: unknown; stage?: unknown }
            errReason.set(ark, typeof r.reason === "string" ? r.reason : typeof r.stage === "string" ? r.stage : "échec")
          }
        }
      }
      for (const a of j.addedArks) if (!failset.has(a)) indexed.add(a)
      for (const r of j.removedArks) indexed.delete(r)
    }

    const indexedArr = [...indexed]
    const errOnly = [...errReason.entries()].filter(([ark]) => !indexed.has(ark))

    if (indexedArr.length > 0) {
      await prisma.document.updateMany({
        where: { projectId: p.id, ark: { in: indexedArr } },
        data: { indexedAt: now },
      })
    }
    for (const [ark, reason] of errOnly) {
      await prisma.document.updateMany({
        where: { projectId: p.id, ark },
        data: { indexError: reason },
      })
    }
    console.log(`  project ${p.id}: indexed=${indexedArr.length}, errorMarked=${errOnly.length}`)
  }
  console.log("backfill done")
  await prisma.$disconnect()
})()
