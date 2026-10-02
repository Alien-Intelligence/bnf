// tests/models/corpus/filters.test.ts
// The corpus mirror of the buffer filters (Track E Phase 8): field-scoped
// `title` / `creator`, the record `kind`, and a one-level `not`, all through
// the one filter→SQL translation (buildCorpusWhere) that snapshot, list,
// crossFacets and removeByFilter share. `arkKindWhere` is the SQL mirror of
// classifyArkKind; the parity test pins the two together over a fixture set.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { createTestUser, createTestProject, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { CorpusQueries, arkKindWhere, type CorpusFilterSet } from "@/models/corpus/queries"
import { CorpusService } from "@/models/corpus/service"
import { ARK_KIND, classifyArkKind, type ArkKind } from "@/models/documents/schema"

let user: User
let project: Project

const DOCS: Array<{ ark: string; docType: string | null; title: string; author: string | null; lang: string | null; year: number | null }> = [
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
]

before(async () => {
  user = await createTestUser()
  project = await createTestProject(user.id, "corpus-filters")
  await prisma.document.createMany({
    data: DOCS.map((d) => ({ ...d, projectId: project.id, source: "gallica", resolveStatus: "resolved" })),
  })
  await CorpusService.addArks(project, user, { arks: DOCS.map((d) => d.ark), reason: "fixture" })
})

after(async () => {
  await cleanupProject(project.id)
  await deleteTestUser(user.id)
})

async function arksFor(filters: CorpusFilterSet): Promise<string[]> {
  return (await CorpusQueries.arksMatchingFilters(project.id, "head", filters)).sort()
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

test("not excludes what it matches and never matches an unknown field", async () => {
  // Everything not French: the German book only — the two language-less
  // documents are NOT matched by `not`.
  assert.deepEqual(await arksFor({ not: { lang: ["fr"] } }), ["ark:/12148/bpt6k9200003"])
  // Press issues except the colonial titles.
  assert.deepEqual(await arksFor({ kind: ["periodical_issue"], not: { title: ["Oran"] } }), [
    "ark:/12148/bd6t9200011",
    "ark:/12148/bpt6k9200002",
  ])
})

test("remove_by_filter with not: the dry run counts exactly the matched set", async () => {
  const preview = await CorpusService.removeByFilter(project, user, {
    filters: { not: { lang: ["fr"] } },
    reason: "aperçu",
    dryRun: true,
  })
  assert.equal(preview.status, "dry_run")
  if (preview.status === "dry_run") assert.equal(preview.matched, 1)
})
