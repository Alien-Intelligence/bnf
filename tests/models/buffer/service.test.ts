// models/buffer/service.test.ts
// BufferService is the heart of the "tampon": it stages search hits, curates
// them, and is the ONE place the buffer touches the versioned corpus (commit →
// CorpusService.addArks → advanceVersion). These tests assert the durable
// invariants the plan §5 calls out, against the real dev Postgres (deterministic,
// no LLM/MCP). Each test owns a fresh project so ordering never matters.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { BufferService, explainRegistration } from "@/models/buffer/service"
import { CorpusService } from "@/models/corpus/service"
import { BufferQueries } from "@/models/buffer/queries"
import { BUFFER_STATUS } from "@/models/buffer/schema"
import { createTestUser, createTestProject, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"

let user: User
const projects: string[] = []

/** A fresh project registered for teardown. */
async function freshProject(label: string): Promise<Project> {
  const p = await createTestProject(user.id, label)
  projects.push(p.id)
  return p
}

const ARK = (n: number) => `ark:/12148/bpt6k${String(n).padStart(6, "0")}`

before(async () => {
  user = await createTestUser()
})

after(async () => {
  for (const id of projects) await cleanupProject(id)
  await deleteTestUser(user.id)
})

// --- registerCandidates: dedupe, skip invalid, refresh vs added -------------

test("registerCandidates dedupes by ARK within a batch (last write wins)", async () => {
  const project = await freshProject("dedupe")
  const result = await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [
      { ark: ARK(1), title: "Premier titre" },
      { ark: ARK(2), title: "Autre" },
      { ark: ARK(1), title: "Titre corrigé" }, // same ARK — collapses to one row
    ],
  })
  assert.equal(result.requested, 3)
  assert.equal(result.added, 2, "two unique ARKs inserted")
  assert.equal(result.total, 2)

  const rows = await prisma.bufferItem.findMany({ where: { projectId: project.id, ark: ARK(1) } })
  assert.equal(rows.length, 1, "no duplicate row for the repeated ARK")
  assert.equal(rows[0].title, "Titre corrigé", "last write wins on metadata")
})

test("registerCandidates skips identifiers that are not valid ARKs", async () => {
  const project = await freshProject("skip-invalid")
  const result = await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [
      { ark: ARK(10) },
      { ark: "cb32895690b/date" }, // periodical COLLECTION form — must never stage
      { ark: "not-an-ark" },
    ],
  })
  assert.equal(result.added, 1)
  assert.equal(result.skipped, 2, "both malformed identifiers rejected")
  const staged = await BufferQueries.candidateArks(project.id)
  assert.deepEqual(staged, [ARK(10)])
})

test("re-registering an existing ARK refreshes metadata, not the row count", async () => {
  const project = await freshProject("refresh")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(20), title: "Titre initial" }],
  })
  const second = await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(20), title: "Titre enrichi", year: 1889 }],
  })
  assert.equal(second.added, 0, "no new row")
  assert.equal(second.refreshed, 1, "existing row refreshed")
  assert.equal(second.total, 1)
  const row = await prisma.bufferItem.findFirstOrThrow({ where: { projectId: project.id, ark: ARK(20) } })
  assert.equal(row.title, "Titre enrichi")
  assert.equal(row.year, 1889)
})

// --- removeByFilter: empty refusal, dry-run purity, real removal ------------

test("removeByFilter refuses an empty filter without mutating", async () => {
  const project = await freshProject("empty-filter")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(30), year: 1889 }],
  })
  const result = await BufferService.removeByFilter(project.id, { filters: {}, dryRun: false })
  assert.equal(result.status, "empty_filter")
  assert.equal(await BufferQueries.count(project.id), 1, "buffer untouched")
})

test("removeByFilter dry-run previews the match set WITHOUT removing", async () => {
  const project = await freshProject("dry-run")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [
      { ark: ARK(40), year: 1889 },
      { ark: ARK(41), year: 1889 },
      { ark: ARK(42), year: 1920 },
    ],
  })
  const preview = await BufferService.removeByFilter(project.id, {
    filters: { yearFrom: 1889, yearTo: 1889 },
    dryRun: true,
  })
  assert.equal(preview.status, "dry_run")
  if (preview.status === "dry_run") assert.equal(preview.matched, 2)
  assert.equal(await BufferQueries.count(project.id), 3, "dry-run mutated nothing")
})

test("removeByFilter (dryRun=false) discards the matching candidates", async () => {
  const project = await freshProject("remove")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [
      { ark: ARK(50), year: 1889 },
      { ark: ARK(51), year: 1920 },
    ],
  })
  const result = await BufferService.removeByFilter(project.id, {
    filters: { yearFrom: 1920, yearTo: 1920 },
    dryRun: false,
  })
  assert.equal(result.status, "removed")
  if (result.status === "removed") assert.equal(result.removed, 1)
  const remaining = await BufferQueries.candidateArks(project.id)
  assert.deepEqual(remaining, [ARK(50)], "only the non-matching candidate remains")
})

// --- commit: advances the corpus version exactly once -----------------------

test("commit moves candidates into the corpus, advancing the version exactly once", async () => {
  const project = await freshProject("commit")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(60), title: "A" }, { ark: ARK(61), title: "B" }],
  })

  const versionsBefore = await prisma.corpusVersion.count({ where: { projectId: project.id } })
  const headBefore = await prisma.project.findUniqueOrThrow({
    where: { id: project.id },
    select: { headVersionId: true },
  })

  const result = await BufferService.commit(project, user, { reason: "unit commit" })
  assert.equal(result.committed, 2)

  const versionsAfter = await prisma.corpusVersion.count({ where: { projectId: project.id } })
  assert.equal(versionsAfter, versionsBefore + 1, "exactly one new version created")

  const projectAfter = await prisma.project.findUniqueOrThrow({
    where: { id: project.id },
    select: { headVersionId: true },
  })
  assert.notEqual(projectAfter.headVersionId, headBefore.headVersionId, "head pointer advanced")

  const members = await prisma.corpusMembership.count({
    where: { versionId: projectAfter.headVersionId ?? "" },
  })
  assert.equal(members, 2, "both ARKs are members of the new head version")

  const candidatesLeft = await prisma.bufferItem.count({
    where: { projectId: project.id, status: BUFFER_STATUS.CANDIDATE },
  })
  const committedRows = await prisma.bufferItem.count({
    where: { projectId: project.id, status: BUFFER_STATUS.COMMITTED },
  })
  assert.equal(candidatesLeft, 0, "committed candidates left the active buffer")
  assert.equal(committedRows, 2, "rows kept as committed provenance")
})

test("commit with an empty buffer does NOT advance a version", async () => {
  const project = await freshProject("commit-empty")
  const versionsBefore = await prisma.corpusVersion.count({ where: { projectId: project.id } })
  const result = await BufferService.commit(project, user, { reason: "nothing staged" })
  assert.equal(result.committed, 0)
  const versionsAfter = await prisma.corpusVersion.count({ where: { projectId: project.id } })
  assert.equal(versionsAfter, versionsBefore, "no version created for an empty commit")
})

test("a committed ARK is not resurrected as a candidate by a later search", async () => {
  const project = await freshProject("no-resurrect")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(70) }],
  })
  await BufferService.commit(project, user, { reason: "commit then re-search" })

  const again = await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(70), title: "Re-trouvé" }],
  })
  assert.equal(again.added, 0, "no new candidate row")
  assert.equal(again.alreadyInCorpus, 1, "reported as already in the corpus, not as a silent refresh")
  const candidates = await BufferQueries.candidateArks(project.id)
  assert.deepEqual(candidates, [], "the committed ARK stays out of the candidate set")
})

// --- clear / discard --------------------------------------------------------

test("clear drops candidate + discarded rows but preserves committed provenance", async () => {
  const project = await freshProject("clear")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(80) }, { ark: ARK(81) }, { ark: ARK(82) }],
  })
  await BufferService.discard(project.id, [ARK(81)]) // → discarded
  await BufferService.commit(project, user, { reason: "commit the rest" }) // ARK(80),ARK(82) → committed

  // Stage one fresh candidate, then clear.
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(83) }],
  })
  const removed = await BufferService.clear(project.id)
  assert.ok(removed >= 1, "clear removed the leftover candidate/discarded rows")

  const committed = await prisma.bufferItem.count({
    where: { projectId: project.id, status: BUFFER_STATUS.COMMITTED },
  })
  const others = await prisma.bufferItem.count({
    where: { projectId: project.id, status: { in: [BUFFER_STATUS.CANDIDATE, BUFFER_STATUS.DISCARDED] } },
  })
  assert.equal(committed, 2, "committed provenance survives clear")
  assert.equal(others, 0, "no candidate/discarded rows remain")
})

test("discard marks candidates discarded (only from the candidate set)", async () => {
  const project = await freshProject("discard")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(90) }, { ark: ARK(91) }],
  })
  const n = await BufferService.discard(project.id, [ARK(90)])
  assert.equal(n, 1)
  assert.deepEqual(await BufferQueries.candidateArks(project.id), [ARK(91)])
  // Discarding again is a no-op (already left the candidate set).
  assert.equal(await BufferService.discard(project.id, [ARK(90)]), 0)
})

// --- Explained staging (Track E Phase 6) -------------------------------------
// Each test reproduces a prod defect; the reason it is red on 0.18.1 is noted.

const fiftyArks = Array.from({ length: 50 }, (_, i) => ARK(1_000 + i))

test("session-(b): re-finding committed ARKs reports alreadyInCorpus with an explanation, not a silent refresh", async () => {
  // Red on 0.18.1: the second search came back `added: 0, refreshed: 50` and
  // nothing said why — the agent cleared the buffer and searched again, ten
  // minutes and 13.3 M input tokens.
  const project = await freshProject("session-b")
  const page = fiftyArks.map((ark) => ({ ark, title: `Notice ${ark}` }))
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: page,
  })
  await BufferService.commit(project, user, { reason: "première recherche" })
  await BufferService.clear(project.id)

  const again = await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: page,
  })
  assert.equal(again.added, 0)
  assert.equal(again.alreadyInCorpus, 50)
  assert.equal(again.refreshed, 0)
  const why = explainRegistration(page.length, again)
  assert.ok(why !== null && why.includes("déjà dans le corpus"), `explained: ${why}`)
})

test("a committed ARK removed from the corpus is restaged by a later search", async () => {
  // Red on 0.18.1: a `committed` row is never touched again, so an ARK the
  // librarian removed from the corpus could never be staged a second time.
  const project = await freshProject("restage")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(1_100), title: "Retiré puis retrouvé" }],
  })
  await BufferService.commit(project, user, { reason: "ajout" })
  await CorpusService.removeArks(project, user, { arks: [ARK(1_100)], reason: "retrait" })

  const again = await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(1_100), title: "Retiré puis retrouvé" }],
  })
  assert.equal(again.added, 1)
  assert.equal(again.restaged, 1)
  assert.deepEqual(await BufferQueries.candidateArks(project.id), [ARK(1_100)])
})

test("an ARK already in the corpus via corpus_add is not staged as a candidate", async () => {
  // Red on 0.18.1: it was staged, and the commit then reported it as a duplicate.
  const project = await freshProject("corpus-add-first")
  await CorpusService.addArks(project, user, { arks: [ARK(1_200)], reason: "ajout direct" })
  const result = await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(1_200), title: "Déjà là" }, { ark: ARK(1_201), title: "Nouveau" }],
  })
  assert.equal(result.added, 1)
  assert.equal(result.alreadyInCorpus, 1)
  assert.deepEqual(await BufferQueries.candidateArks(project.id), [ARK(1_201)])
  const row = await prisma.bufferItem.findFirstOrThrow({ where: { projectId: project.id, ark: ARK(1_200) } })
  assert.equal(row.status, BUFFER_STATUS.COMMITTED, "kept as provenance, outside the candidate set")
})

test("a search never resurrects a discarded ARK; an explicit buffer_add does", async () => {
  const project = await freshProject("discarded")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(1_300), title: "Écarté" }],
  })
  await BufferService.discard(project.id, [ARK(1_300)])

  const searched = await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(1_300), title: "Écarté" }],
  })
  assert.equal(searched.added, 0)
  assert.equal(searched.previouslyDiscarded, 1)
  assert.deepEqual(await BufferQueries.candidateArks(project.id), [])
  assert.match(explainRegistration(1, searched) ?? "", /1 a été écarté plus tôt, non réintroduit/)

  const named = await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "buffer_add",
    restageDiscarded: true,
    candidates: [{ ark: ARK(1_300) }],
  })
  assert.equal(named.added, 1, "the librarian named it: it is staged again")
  assert.deepEqual(await BufferQueries.candidateArks(project.id), [ARK(1_300)])
})

test("parallel registrations of overlapping batches count each ARK as added once", async () => {
  // Red on 0.18.1: `added` came from createdAt === updatedAt, so two
  // sub-agents staging overlapping pages could both count the same ARK.
  const project = await freshProject("parallel")
  const a = Array.from({ length: 30 }, (_, i) => ({ ark: ARK(1_400 + i), title: "A" }))
  const b = Array.from({ length: 30 }, (_, i) => ({ ark: ARK(1_420 + i), title: "B" }))
  const [ra, rb] = await Promise.all([
    BufferService.registerCandidates({ projectId: project.id, originTool: "corpus_search", restageDiscarded: false, candidates: a }),
    BufferService.registerCandidates({ projectId: project.id, originTool: "corpus_search", restageDiscarded: false, candidates: b }),
  ])
  assert.equal(ra.added + rb.added, 50, "10 shared ARKs, each counted once")
  assert.equal(await prisma.bufferItem.count({ where: { projectId: project.id } }), 50)
})

test("commit reports canonicalizationPending for added cb notices", async () => {
  // Red on 0.18.1: the commit's total was final as far as the agent knew; 31 s
  // later the canonicaliser replaced 16 notices and the corpus held 44, not 58.
  const project = await freshProject("canonical-pending")
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [
      { ark: "ark:/12148/cb12000101z", title: "Notice A" },
      { ark: "ark:/12148/cb12000102z", title: "Notice B" },
      { ark: ARK(1_500), title: "Numérisé" },
    ],
  })
  const result = await BufferService.commit(project, user, { reason: "notices" })
  assert.equal(result.canonicalizationPending, 2)
  assert.equal(result.catalogueNotices, 2)
})

test("a bare candidate is reported unresolved, and a search that brings its title resolves it", async () => {
  const project = await freshProject("unresolved")
  const bare = await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "buffer_add",
    restageDiscarded: true,
    candidates: [{ ark: ARK(1_600) }, { ark: ARK(1_601) }],
  })
  assert.equal(bare.unresolved, 2)
  const found = await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(1_600), title: "Trouvé par la recherche" }],
  })
  assert.equal(found.refreshed, 1)
  assert.equal(found.unresolved, 0)
  const row = await prisma.bufferItem.findFirstOrThrow({ where: { projectId: project.id, ark: ARK(1_600) } })
  assert.equal(row.enrichStatus, "resolved")
})
