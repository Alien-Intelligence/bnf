// tests/models/corpus/filters.test.ts
// The corpus mirror of the buffer filters (Track E Phase 8): field-scoped
// `title` / `creator`, the record `kind`, and a one-level `not`, all through
// the one filter→SQL translation (buildCorpusWhere) that snapshot, list,
// crossFacets and removeByFilter share. `arkKindWhere` is the SQL mirror of
// classifyArkKind; the parity test pins the two together over a fixture set.
// Decision 4 for every `not` dimension: a document whose value is unknown is
// never excluded by a read and never removed by a removal; the dry run
// reports it (`notUnknown`).
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { createTestUser, createTestProject, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import type { CorpusFilterSet } from "@/models/corpus/types"
import { CorpusService } from "@/models/corpus/service"
import { arkKindWhere, classifyArkKind } from "@/lib/documents/ark-kind"
import { ARK_KIND, type ArkKind } from "@/models/documents/schema"
import { DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"

let user: User
let project: Project

type Fixture = {
  ark: string
  docType: string | null
  title: string
  author: string | null
  lang: string | null
  year: number | null
  resolveStatus?: string
}

const DOCS: Fixture[] = [
  { ark: "ark:/12148/bpt6k9200001", docType: "press", title: "L'Écho d'Oran", author: null, lang: "fr", year: 1937 },
  { ark: "ark:/12148/bpt6k9200002", docType: "press", title: "Le Petit Marseillais", author: null, lang: "fr", year: 1937 },
  { ark: "ark:/12148/bpt6k9200003", docType: "book", title: "Die Alamannen", author: "Geuenich, Dieter", lang: "de", year: 1997 },
  { ark: "ark:/12148/btv1b9200004", docType: "image", title: "Village suisse", author: null, lang: null, year: 1896 },
  { ark: "ark:/12148/btv1b9200005", docType: "map", title: "Plan de Genève", author: null, lang: "fr", year: 1896 },
  { ark: "ark:/12148/bpt6k9200006", docType: "text", title: "Texte", author: null, lang: "fr", year: 1900 },
  { ark: "ark:/12148/bpt6k9200007", docType: null, title: "Sans type", author: null, lang: null, year: null },
  { ark: "ark:/12148/cb92000008z", docType: "press", title: "Le Temps (titre)", author: null, lang: "fr", year: 1861 },
  { ark: "ark:/12148/cb92000009z", docType: null, title: "Notice", author: "Clovis", lang: "fr", year: 1960 },
  { ark: "ark:/12148/cb92000010z", docType: "book", title: "Notice livre", author: null, lang: "fr", year: 1970 },
  { ark: "ark:/12148/bd6t9200011", docType: "press", title: "Numéro bd6t", author: null, lang: "fr", year: 1937 },
  // A stub still waiting for its metadata: its ingestion class is unknown.
  {
    ark: "ark:/12148/bpt6k9200012",
    docType: null,
    title: "En attente",
    author: null,
    lang: "fr",
    year: null,
    resolveStatus: DOCUMENT_RESOLVE_STATUS.PENDING,
  },
]

const ALL = DOCS.map((d) => d.ark).sort()
const except = (...arks: string[]) => ALL.filter((a) => !arks.includes(a))

before(async () => {
  user = await createTestUser()
  project = await createTestProject(user.id, "corpus-filters")
  await prisma.document.createMany({
    data: DOCS.map((d) => ({
      ...d,
      projectId: project.id,
      source: "gallica",
      resolveStatus: d.resolveStatus ?? DOCUMENT_RESOLVE_STATUS.RESOLVED,
    })),
  })
  await CorpusService.addArks(project, user, { arks: DOCS.map((d) => d.ark), reason: "fixture" })
})

after(async () => {
  await cleanupProject(project.id)
  await deleteTestUser(user.id)
})

/** What a READ (list, snapshot, export) shows under `filters`. */
async function arksFor(filters: CorpusFilterSet): Promise<string[]> {
  return (await CorpusService.exportRows(project.id, "head", filters)).rows.map((r) => r.ark).sort()
}

/** What a remove-by-filter would remove under `filters`. */
async function arksRemovedBy(filters: CorpusFilterSet): Promise<string[]> {
  return (await CorpusService.arksMatchingFilters(project.id, "head", filters)).sort()
}

test("arkKindWhere is the SQL mirror of classifyArkKind", async () => {
  for (const kind of Object.values(ARK_KIND) as ArkKind[]) {
    const sql = (
      await prisma.document.findMany({
        where: { projectId: project.id, ...arkKindWhere(kind) },
        select: { ark: true },
      })
    )
      .map((d) => d.ark)
      .sort()
    const ts = DOCS.filter((d) => classifyArkKind({ ark: d.ark, collectionEntry: false, docType: d.docType }) === kind)
      .map((d) => d.ark)
      .sort()
    assert.deepEqual(sql, ts, `kind ${kind}`)
  }
})

test("title / creator are contains-any; kind selects record kinds", async () => {
  assert.deepEqual(await arksFor({ title: ["oran", "genève"] }), ["ark:/12148/bpt6k9200001", "ark:/12148/btv1b9200005"])
  assert.deepEqual(await arksFor({ creator: ["clovis"] }), ["ark:/12148/cb92000009z"])
  assert.deepEqual(await arksFor({ kind: ["periodical_issue"] }), [
    "ark:/12148/bd6t9200011",
    "ark:/12148/bpt6k9200001",
    "ark:/12148/bpt6k9200002",
  ])
})

test("not.lang — ONE rule: unknown language is neither listed nor removed, and the read reports it", async () => {
  // Everything not French: the German book only — the two language-less
  // documents are never matched by `not`.
  assert.deepEqual(await arksFor({ not: { lang: ["fr"] } }), ["ark:/12148/bpt6k9200003"])
  assert.deepEqual(await arksRemovedBy({ not: { lang: ["fr"] } }), ["ark:/12148/bpt6k9200003"])
  const snapshot = await CorpusService.snapshot(project.id, "head", { filters: { not: { lang: ["fr"] } }, limit: 0 })
  assert.deepEqual(snapshot.notUnknown, { lang: 2 }, "the read says what it left out")
  const page = await CorpusService.list(project.id, "head", { filters: { not: { lang: ["fr"] } } })
  assert.deepEqual(page.notUnknown, { lang: 2 })
  // Press issues except the colonial titles.
  assert.deepEqual(await arksFor({ kind: ["periodical_issue"], not: { title: ["Oran"] } }), [
    "ark:/12148/bd6t9200011",
    "ark:/12148/bpt6k9200002",
  ])
})

test("not.q is two-valued: documents with no author or excerpt are not hidden", async () => {
  // Every fixture has a title, none an excerpt, most no author: before the fix
  // `NOT(title ILIKE … OR author ILIKE … OR excerpt ILIKE …)` was NULL for them.
  assert.deepEqual(await arksFor({ not: { q: "Oran" } }), except("ark:/12148/bpt6k9200001"))
  assert.deepEqual(await arksRemovedBy({ not: { q: "Oran" } }), except("ark:/12148/bpt6k9200001"))
})

test("not.kind agrees with classifyArkKind, NULL docType included", async () => {
  for (const kind of Object.values(ARK_KIND) as ArkKind[]) {
    const expected = DOCS.filter((d) => classifyArkKind({ ark: d.ark, collectionEntry: false, docType: d.docType }) !== kind)
      .map((d) => d.ark)
      .sort()
    assert.deepEqual(await arksFor({ not: { kind: [kind] } }), expected, `read not.kind=${kind}`)
    assert.deepEqual(await arksRemovedBy({ not: { kind: [kind] } }), expected, `remove not.kind=${kind}`)
  }
})

test("not.ingest: an unresolved stub's class is unknown — neither listed nor removed", async () => {
  // The fixtures carry no IIIF manifest: every RESOLVED one is non_numerise.
  assert.deepEqual(await arksFor({ not: { ingest: ["non_numerise"] } }), [])
  assert.deepEqual(await arksRemovedBy({ not: { ingest: ["ocr"] } }), except("ark:/12148/bpt6k9200012"))
  assert.deepEqual(await arksFor({ not: { ingest: ["ocr"] } }), except("ark:/12148/bpt6k9200012"))
})

test("not.yearFrom: single-year rows are KNOWN and judged; undated ones are left out and reported", async () => {
  // year 1900 < 1940 → not in [1940, …] → kept by `not`, i.e. listed.
  const listed = await arksFor({ not: { yearFrom: 1940 } })
  assert.ok(listed.includes("ark:/12148/bpt6k9200006"), "the 1900 text is listed")
  assert.ok(!listed.includes("ark:/12148/bpt6k9200003"), "the 1997 book is excluded")
  assert.deepEqual(await arksRemovedBy({ not: { yearFrom: 1940 } }), listed)
  const snapshot = await CorpusService.snapshot(project.id, "head", { filters: { not: { yearFrom: 1940 } }, limit: 0 })
  assert.deepEqual(snapshot.notUnknown, { year: 2 }, "the two undated documents are reported")
})

test("not.outcome is always known: it partitions the corpus", async () => {
  assert.deepEqual(await arksFor({ not: { outcome: ["indexed"] } }), ALL)
  assert.deepEqual(await arksFor({ not: { outcome: ["not_ingested", "excluded"] } }), [])
})

test("remove_by_filter with not: the dry run counts the removal and reports what it left in place", async () => {
  const preview = await CorpusService.removeByFilter(project, user, {
    filters: { not: { lang: ["fr"], ingest: ["non_numerise"] } },
    reason: "aperçu",
    dryRun: true,
  })
  assert.equal(preview.status, "dry_run")
  if (preview.status !== "dry_run") return
  assert.equal(preview.matched, 1, "the German book: known language, known class, not French")
  assert.deepEqual(preview.notUnknown, { lang: 2, ingest: 1 })

  const langOnly = await CorpusService.removeByFilter(project, user, {
    filters: { not: { lang: ["fr"] } },
    reason: "aperçu",
    dryRun: true,
  })
  assert.equal(langOnly.status, "dry_run")
  if (langOnly.status !== "dry_run") return
  assert.equal(langOnly.matched, 1)
  assert.deepEqual(langOnly.notUnknown, { lang: 2 })
})
