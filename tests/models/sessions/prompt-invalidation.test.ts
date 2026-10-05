// tests/models/sessions/prompt-invalidation.test.ts
// Every change that makes a cached system prompt stale drops it, in the same
// transaction (SessionQueries owns the write): a head move (buffer_commit,
// corpus_add, a removal — they all advance the version) drops the corpus
// prompts, which embed "Version N — X document(s)"; an ingestion drops the
// research prompts, which embed ÉTAT DU CORPUS; revoking a grant drops the
// derived workspace's prompts, which must now say the access is gone; and
// resolving a stub drops the corpus prompts, which embed the head's type /
// lang / period counts (a stub has none).
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { PROJECT_ACCESS } from "@/lib/authz/project-access"
import { createTestUser, createTestProject, createTestSession, deleteTestUser } from "@/lib/testing/fixtures"
import { markHeadIngested } from "@/lib/testing/mark-ingested"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { resolvePendingForProject } from "@/lib/documents/resolver"
import { CorpusService } from "@/models/corpus/service"
import { IngestService } from "@/models/ingest/service"
import { ProjectQueries } from "@/models/projects/queries"
import { ProjectService, ProjectSharingService } from "@/models/projects/service"
import { SESSION_SCOPE } from "@/models/sessions/schema"

let owner: User
let reader: User
let groupId: string
const projects: string[] = []
const CACHED = "PROMPT EN CACHE"

async function cache(...ids: string[]) {
  await prisma.appSession.updateMany({ where: { id: { in: ids } }, data: { systemPrompt: CACHED, promptLocale: "fr" } })
}
async function cached(id: string) {
  return (await prisma.appSession.findUniqueOrThrow({ where: { id } })).systemPrompt
}

before(async () => {
  owner = await createTestUser()
  reader = await createTestUser()
  const group = await prisma.group.create({
    data: { name: `TEST invalidation ${randomUUID()}`, slug: `test-invalidation-${randomUUID()}` },
  })
  groupId = group.id
  await prisma.groupMember.create({ data: { groupId, userId: reader.id } })
})

after(async () => {
  for (const id of [...projects].reverse()) await cleanupProject(id)
  await prisma.group.deleteMany({ where: { id: groupId } })
  await deleteTestUser(owner.id)
  await deleteTestUser(reader.id)
})

test("a head move drops every corpus prompt of the project, not its research prompts", async () => {
  const project: Project = await createTestProject(owner.id, "head-move")
  projects.push(project.id)
  const corpusSession = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  const researchSession = await createTestSession(project.id, SESSION_SCOPE.RESEARCH)
  const ark = "ark:/12148/bpt6k9810001"
  await prisma.document.create({
    data: { ark, projectId: project.id, title: "Doc", source: "gallica", resolveStatus: "resolved" },
  })
  await cache(corpusSession, researchSession)
  await CorpusService.addArks(project, owner, { arks: [ark], reason: "test" })
  assert.equal(await cached(corpusSession), null, "the corpus prompt described the previous head")
  assert.equal(await cached(researchSession), CACHED, "a head move says nothing new to research")
})

test("an ingestion drops the research prompts in the same transaction as the state change", async () => {
  const project: Project = await createTestProject(owner.id, "ingest-noop")
  projects.push(project.id)
  const researchSession = await createTestSession(project.id, SESSION_SCOPE.RESEARCH)
  await cache(researchSession)
  // An empty project: the submit records a no-op ingestion (no worker call).
  await IngestService.submit(project, owner, {})
  assert.equal(await cached(researchSession), null)
})

test("revoking a grant drops the derived workspace's prompts", async () => {
  const source = await createTestProject(owner.id, "unshare-source")
  projects.push(source.id)
  await markHeadIngested(source.id)
  const withShares = await ProjectQueries.get(source.id)
  assert.ok(withShares)
  await ProjectSharingService.share(withShares, owner.id, { groupId, access: PROJECT_ACCESS.READ })
  const sourceAgain = await ProjectQueries.get(source.id)
  assert.ok(sourceAgain)
  const derived = await ProjectService.createDerived({
    source: sourceAgain,
    user: { ...reader, groupIds: [groupId] },
    name: "Espace dérivé",
  })
  projects.push(derived.id)
  const derivedSession = await createTestSession(derived.id, SESSION_SCOPE.RESEARCH)
  await cache(derivedSession)
  await ProjectSharingService.unshare(source.id, groupId)
  assert.equal(await cached(derivedSession), null, "its cached prompt still said the corpus was readable")
})

test("resolving a stub drops the corpus prompts (their facet counts changed); a failed resolve does not", async () => {
  const project: Project = await createTestProject(owner.id, "resolve-facets")
  projects.push(project.id)
  const corpusSession = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  const researchSession = await createTestSession(project.id, SESSION_SCOPE.RESEARCH)
  const ok = "ark:/12148/bpt6k9810011"
  const ko = "ark:/12148/bpt6k9810012"
  // Two bare stubs in the head (corpus_add creates them pending).
  await CorpusService.addArks(project, owner, { arks: [ok, ko], reason: "test" })

  // A batch where nothing resolves leaves the prompts alone.
  await cache(corpusSession, researchSession)
  await resolvePendingForProject(project.id, {
    client: { resolveArks: async (arks) => arks.map((ark) => ({ ark, ok: false as const, error: new Error("BnF down") })) },
  })
  assert.equal(await cached(corpusSession), CACHED, "no facet changed")

  // A batch where one resolves drops the corpus prompts in the same transaction.
  await resolvePendingForProject(project.id, {
    client: {
      resolveArks: async (arks) =>
        arks.map((ark) =>
          ark === ok
            ? { ark, ok: true as const, document: { ark: "bpt6k9810011", title: "Résolu", date: "1937", doc_type: "texte", language: "fre" } }
            : { ark, ok: false as const, error: new Error("BnF down") },
        ),
    },
  })
  assert.equal(await cached(corpusSession), null, "the corpus prompt's counts changed")
  assert.equal(await cached(researchSession), CACHED, "a resolve says nothing new to research")
})
