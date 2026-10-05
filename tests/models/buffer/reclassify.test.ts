// tests/models/buffer/reclassify.test.ts
// The boot-time reclassifier (Track E Phase 4) rewrites the 86 765 prod buffer
// rows into the canonical vocabulary once: raw dc:type labels move to
// docTypeRaw, docType becomes the canonical code (the search's own doc_type
// filter, recovered from the stored CQL, wins over the label), lang becomes
// canonical, every row gets its arkKind, and bare rows take their metadata from
// a resolved same-project Document at zero BnF cost. It must be idempotent: the
// version gate makes a second pass touch nothing.
//
// Runs against the dev Postgres like service.test.ts. The first call also
// reclassifies whatever legacy rows the dev DB holds — exactly what the first
// boot of the new version does.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { BUFFER_CLASSIFIER_VERSION } from "@/lib/constants"
import { reclassifyBufferItems } from "@/lib/buffer/reclassify"
import { BUFFER_ENRICH_STATUS, BUFFER_STATUS } from "@/models/buffer/schema"
import { ARK_KIND } from "@/models/documents/schema"
import { createTestUser, createTestProject, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"

let user: User
let project: Project

const PRESS_CQL =
  '(gallica all "incendie" prox/unit=word/distance=5 "forêt") and dc.date = "1937" and dc.type all "fascicule"'

const ARKS = {
  pressIssue: "ark:/12148/bpt6k7600001",
  pressCollection: "ark:/12148/cb32700001x",
  catalogueNotice: "ark:/12148/cb12000001z",
  bareCommitted: "ark:/12148/bpt6k7600002",
  bareCandidate: "ark:/12148/bpt6k7600003",
  bareDiscarded: "ark:/12148/bpt6k7600004",
  german: "ark:/12148/bpt6k7600005",
  unfilteredText: "ark:/12148/bpt6k7600006",
}

/** A legacy (pre-v2) buffer row, as 0.18.1 wrote it. */
function legacyRow(
  ark: string,
  data: {
    title?: string | null
    docType?: string | null
    lang?: string | null
    source?: string
    originTool?: string
    originQuery?: string | null
    status?: string
    enrichStatus?: string | null
    enrichAttempts?: number
  },
) {
  return prisma.bufferItem.create({
    data: {
      projectId: project.id,
      ark,
      title: data.title ?? null,
      docType: data.docType ?? null,
      lang: data.lang ?? null,
      source: data.source ?? "gallica",
      originTool: data.originTool ?? "corpus_search",
      originQuery: data.originQuery ?? null,
      status: data.status ?? BUFFER_STATUS.CANDIDATE,
      enrichStatus: data.enrichStatus ?? null,
      enrichAttempts: data.enrichAttempts ?? 0,
      classifierVersion: 0,
    },
  })
}

before(async () => {
  user = await createTestUser()
  project = await createTestProject(user.id, "reclassify")

  // A committed ARK whose Document is resolved: the bare buffer row copies it.
  await prisma.document.create({
    data: {
      ark: ARKS.bareCommitted,
      projectId: project.id,
      title: "Le Petit Journal",
      author: "Collectif",
      year: 1937,
      dateLabel: "1937-07-12",
      docType: "press",
      lang: "fr",
      source: "gallica",
      resolveStatus: "resolved",
      rawMetadata: {
        publisher: "Imprimerie du Petit Journal",
        gallica_typedoc: "periodiques:fascicules",
        doc_type: "texte",
        gallica_url: "https://gallica.bnf.fr/ark:/12148/bpt6k-petit-journal",
      },
    },
  })

  await legacyRow(ARKS.pressIssue, { title: "Le Temps", docType: "Texte", lang: "fre", originQuery: PRESS_CQL })
  await legacyRow(ARKS.pressCollection, { title: "Le Temps (collection)", docType: "text", originQuery: PRESS_CQL })
  await legacyRow(ARKS.catalogueNotice, {
    title: "Les Alamans",
    source: "catalogue",
    originQuery: 'bib.subject all "Alamans"',
  })
  await legacyRow(ARKS.bareCommitted, {
    originTool: "buffer_add",
    status: BUFFER_STATUS.COMMITTED,
  })
  await legacyRow(ARKS.bareCandidate, { originTool: "buffer_add" })
  await legacyRow(ARKS.bareDiscarded, { originTool: "buffer_add", status: BUFFER_STATUS.DISCARDED })
  await legacyRow(ARKS.german, { title: "Die Alamannen", docType: "Monographie imprimée", lang: "ger" })
  await legacyRow(ARKS.unfilteredText, { title: "Un texte", docType: "text", originQuery: 'gallica all "x"' })
})

after(async () => {
  await cleanupProject(project.id)
  await deleteTestUser(user.id)
})

async function row(ark: string) {
  return prisma.bufferItem.findUniqueOrThrow({
    where: { projectId_ark: { projectId: project.id, ark } },
  })
}

test("reclassifyBufferItems rewrites legacy rows into the canonical vocabulary, then is a no-op", async () => {
  const first = await reclassifyBufferItems()
  assert.equal(first.complete, true)
  assert.ok(first.updated >= 8, `at least the 8 seeded rows were updated (got ${first.updated})`)

  // The search's doc_type filter (in the stored CQL) wins over the hit label.
  const issue = await row(ARKS.pressIssue)
  assert.equal(issue.docType, "press")
  assert.equal(issue.docTypeRaw, "Texte")
  assert.equal(issue.arkKind, ARK_KIND.PERIODICAL_ISSUE)
  assert.equal(issue.lang, "fr")
  assert.equal(issue.classifierVersion, BUFFER_CLASSIFIER_VERSION)

  // A cb… ARK from the same press search is the periodical title.
  const collection = await row(ARKS.pressCollection)
  assert.equal(collection.docType, "press")
  assert.equal(collection.arkKind, ARK_KIND.PERIODICAL_COLLECTION)

  // A catalogue cb… with no type is a catalogue notice; its docType stays null.
  const notice = await row(ARKS.catalogueNotice)
  assert.equal(notice.docType, null)
  assert.equal(notice.docTypeRaw, null)
  assert.equal(notice.arkKind, ARK_KIND.CATALOGUE_NOTICE)
  assert.equal(notice.enrichStatus, null, "a titled row is not queued for enrichment")

  // A bare committed row copies the resolved Document — no BnF call.
  const copied = await row(ARKS.bareCommitted)
  assert.equal(copied.title, "Le Petit Journal")
  assert.equal(copied.creator, "Collectif")
  assert.equal(copied.year, 1937)
  assert.equal(copied.dateLabel, "1937-07-12")
  assert.equal(copied.docType, "press")
  assert.equal(copied.lang, "fr")
  assert.equal(copied.publisher, "Imprimerie du Petit Journal")
  assert.equal(copied.docTypeRaw, "texte", "the raw label is copied, not lost")
  assert.equal(copied.gallicaUrl, "https://gallica.bnf.fr/ark:/12148/bpt6k-petit-journal")
  assert.equal(copied.arkKind, ARK_KIND.PERIODICAL_ISSUE)
  assert.equal(copied.enrichStatus, BUFFER_ENRICH_STATUS.RESOLVED)

  // A bare candidate with no Document is queued for the Phase 9 drain…
  const pending = await row(ARKS.bareCandidate)
  assert.equal(pending.enrichStatus, BUFFER_ENRICH_STATUS.PENDING)
  assert.equal(pending.arkKind, ARK_KIND.UNKNOWN)
  // …a bare discarded one is not curated anymore, so it is left alone.
  const discarded = await row(ARKS.bareDiscarded)
  assert.equal(discarded.enrichStatus, null)

  // MARC bibliographic code → ISO; the label maps through the table.
  const german = await row(ARKS.german)
  assert.equal(german.lang, "de")
  assert.equal(german.docType, "book")
  assert.equal(german.docTypeRaw, "Monographie imprimée")
  assert.equal(german.arkKind, ARK_KIND.MONOGRAPH)

  // `text` without a doc_type filter stays ambiguous: kind unknown, not book.
  const text = await row(ARKS.unfilteredText)
  assert.equal(text.docType, "text")
  assert.equal(text.arkKind, ARK_KIND.UNKNOWN)

  const seeded = await prisma.bufferItem.count({
    where: { projectId: project.id, classifierVersion: { lt: BUFFER_CLASSIFIER_VERSION } },
  })
  assert.equal(seeded, 0, "every seeded row carries the current classifier version")

  const second = await reclassifyBufferItems()
  assert.equal(second.updated, 0, "idempotent: the version gate makes a second pass a no-op")
  const again = await row(ARKS.pressIssue)
  assert.equal(again.docTypeRaw, "Texte", "a second pass never moves the canonical code into docTypeRaw")
})

test("a run stops at its time ceiling, reports it, and a later run finishes the job", async () => {
  await legacyRow("ark:/12148/bpt6k9590001", { title: "Tardif", docType: "Texte" })
  const stopped = await reclassifyBufferItems({ maxMs: 0 })
  assert.deepEqual(stopped, { updated: 0, complete: false })
  const resumed = await reclassifyBufferItems()
  assert.equal(resumed.complete, true)
  assert.ok(resumed.updated >= 1)
})

test("a bare candidate the drain already gave up on keeps its terminal status", async () => {
  // A legacy bare row the drain failed past its attempt ceiling before the
  // reclassifier reached it: re-queueing it would leave it pending forever
  // (never retaken) and counted unresolved.
  const ark = "ark:/12148/bpt6k9590002"
  await legacyRow(ark, { originTool: "buffer_add", enrichStatus: BUFFER_ENRICH_STATUS.FAILED, enrichAttempts: 3 })
  await reclassifyBufferItems()
  const failed = await row(ark)
  assert.equal(failed.classifierVersion, BUFFER_CLASSIFIER_VERSION, "still reclassified")
  assert.equal(failed.enrichStatus, BUFFER_ENRICH_STATUS.FAILED, "never regressed to pending")
})
