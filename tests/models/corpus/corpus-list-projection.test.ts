// tests/models/corpus/corpus-list-projection.test.ts
// corpus_list exposes the Gallica subcategory: it is an allowed `fields`
// projection, a filter dimension validated by the same schema as REST, and
// present in the full row when no projection is asked for.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { corpusListTool } from "@/lib/agent/tools/corpus"
import type { TurnScopedCtx } from "@/lib/agent/tools/registry-factory"
import { createTestUser, createTestProject, createTestSession, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { CorpusService } from "@/models/corpus/service"
import { DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"
import { SESSION_SCOPE } from "@/models/sessions/schema"

let userRow: User
let project: Project
let sessionId: string

const FASCICULE = "ark:/12148/bpt6k9400001"
const MONOGRAPH = "ark:/12148/bpt6k9400002"

function ctx(): TurnScopedCtx {
  return {
    signal: new AbortController().signal,
    request: new Request("http://localhost/test"),
    db: prisma,
    user: { ...userRow, groupIds: [] },
    appSessionId: sessionId,
    projectId: project.id,
    corpusProjectId: project.id,
    corpusReachable: true,
    scope: SESSION_SCOPE.CORPUS,
  }
}

before(async () => {
  userRow = await createTestUser()
  project = await createTestProject(userRow.id, "corpus-list-projection")
  sessionId = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  await prisma.document.createMany({
    data: [
      { ark: FASCICULE, docType: "press", subtype: "fascicules", title: "Fascicule" },
      { ark: MONOGRAPH, docType: "book", subtype: null, title: "Monographie" },
    ].map((d) => ({
      ...d,
      projectId: project.id,
      source: "gallica",
      lang: "fr",
      resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
    })),
  })
  await CorpusService.addArks(project, userRow, { arks: [FASCICULE, MONOGRAPH], reason: "fixture" })
})

after(async () => {
  await cleanupProject(project.id)
  await deleteTestUser(userRow.id)
})

test("`subtype` is an allowed projection and comes back beside ark", async () => {
  const input = corpusListTool.inputSchema.parse({ fields: ["subtype"] })
  const result = (await corpusListTool.handler(input, ctx())) as { documents: Array<Record<string, unknown>> }
  const byArk = new Map(result.documents.map((d) => [d.ark, d]))
  assert.deepEqual(byArk.get(FASCICULE), { ark: FASCICULE, subtype: "fascicules" })
  assert.deepEqual(byArk.get(MONOGRAPH), { ark: MONOGRAPH, subtype: null })
})

test("the full row carries subtype when no projection is requested", async () => {
  const input = corpusListTool.inputSchema.parse({})
  const result = (await corpusListTool.handler(input, ctx())) as { documents: Array<Record<string, unknown>> }
  assert.equal(result.documents.find((d) => d.ark === FASCICULE)?.subtype, "fascicules")
})

test("filters.subtype selects through the same validator as REST", async () => {
  const input = corpusListTool.inputSchema.parse({ filters: { subtype: ["fascicules"] } })
  const result = (await corpusListTool.handler(input, ctx())) as { total: number; documents: Array<{ ark: string }> }
  assert.equal(result.total, 1)
  assert.deepEqual(result.documents.map((d) => d.ark), [FASCICULE])
})

test("an invalid subtype is refused by the input schema, in filters and inside not", () => {
  assert.equal(corpusListTool.inputSchema.safeParse({ filters: { subtype: ["gazette"] } }).success, false)
  assert.equal(corpusListTool.inputSchema.safeParse({ filters: { not: { subtype: ["gazette"] } } }).success, false)
  assert.equal(corpusListTool.inputSchema.safeParse({ fields: ["subtypes"] }).success, false)
})
