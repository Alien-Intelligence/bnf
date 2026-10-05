// tests/models/filter-bounds.test.ts
// Two properties of the filter boundary, each pinned against the mutation
// that would break it (review pass 4):
//   - the corpus filter schema is strict at BOTH levels on the agent path —
//     the one the tools validate with (an outer `z.object` or an inner one
//     would silently drop `langs` / `not.langs` and widen a removal);
//   - the language bound is computed against the RIGHT store: the HEAD
//     version of THIS corpus, and THIS project's buffer — not every version's
//     membership, not every project.
import "server-only"

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { Project, User } from "@/lib/generated/prisma/client"
import { FilterValueError } from "@/lib/filters"
import { createTestProject, createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { prisma } from "@/lib/db"
import { corpusListTool, corpusRemoveByFilterTool } from "@/lib/agent/tools/corpus"
import { bufferListTool, bufferRemoveByFilterTool } from "@/lib/agent/tools/buffer"
import { BufferService } from "@/models/buffer/service"
import { CorpusService } from "@/models/corpus/service"
import { corpusAgentFilterSetSchema, corpusFilterSetSchema } from "@/models/corpus/types"
import { DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"

let user: User
let mine: Project
let other: Project

const ARK = (n: number) => `ark:/12148/bpt6k97${String(n).padStart(5, "0")}`

async function resolvedDoc(projectId: string, ark: string, lang: string) {
  await prisma.document.create({
    data: { ark, projectId, title: `Doc ${ark}`, lang, source: "gallica", resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED },
  })
}

before(async () => {
  user = await createTestUser()
  mine = await createTestProject(user.id, "bounds-mine")
  other = await createTestProject(user.id, "bounds-other")
  // THIS corpus: a French document in the head; a German one that was in an
  // EARLIER version and removed since.
  await resolvedDoc(mine.id, ARK(1), "fr")
  await resolvedDoc(mine.id, ARK(2), "de")
  await CorpusService.addArks(mine, user, { arks: [ARK(1), ARK(2)], reason: "fixture" })
  await CorpusService.removeArks(mine, user, { arks: [ARK(2)], reason: "fixture" })
  // ANOTHER project holds Italian in its corpus and in its buffer.
  await resolvedDoc(other.id, ARK(3), "it")
  await CorpusService.addArks(other, user, { arks: [ARK(3)], reason: "fixture" })
  await BufferService.registerCandidates({
    projectId: other.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(4), title: "Altro", lang: "it" }],
  })
  // THIS buffer: French only.
  await BufferService.registerCandidates({
    projectId: mine.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark: ARK(5), title: "Un", lang: "fr" }],
  })
})

after(async () => {
  await cleanupProject(mine.id)
  await cleanupProject(other.id)
  await deleteTestUser(user.id)
})

test("the corpus filter schema is strict at both levels, on the agent path and the REST/page path", () => {
  for (const schema of [corpusAgentFilterSetSchema, corpusFilterSetSchema]) {
    assert.equal(schema.safeParse({ langs: ["fr"] }).success, false, "outer unknown key")
    assert.equal(schema.safeParse({ not: { langs: ["fr"] } }).success, false, "inner unknown key")
    assert.equal(schema.safeParse({ not: { not: { lang: ["fr"] } } }).success, false, "nested not")
  }
  assert.equal(corpusAgentFilterSetSchema.safeParse({ session: [crypto.randomUUID()] }).success, false, "no session for the agent")
})

test("the corpus and buffer TOOL inputs are strict: a misspelt `filter` or a top-level `not` is refused", () => {
  assert.equal(corpusListTool.inputSchema.safeParse({ filters: { not: { langs: ["fr"] } } }).success, false)
  assert.equal(corpusListTool.inputSchema.safeParse({ filter: { lang: ["fr"] } }).success, false)
  assert.equal(
    corpusRemoveByFilterTool.inputSchema.safeParse({ filters: { type: ["book"] }, not: { lang: ["fr"] }, reason: "x" }).success,
    false,
  )
  assert.equal(bufferListTool.inputSchema.safeParse({ filter: { lang: ["fr"] } }).success, false)
  assert.equal(
    bufferRemoveByFilterTool.inputSchema.safeParse({ filters: { type: ["book"] }, not: { lang: ["fr"] } }).success,
    false,
  )
})

test("the corpus language bound is THIS project's HEAD version — not an earlier version, not another project", async () => {
  await assert.rejects(CorpusService.list(mine.id, "head", { filters: { lang: ["de"] } }), FilterValueError, "only in an earlier version")
  await assert.rejects(CorpusService.list(mine.id, "head", { filters: { not: { lang: ["it"] } } }), FilterValueError, "only in another project")
  const page = await CorpusService.list(mine.id, "head", { filters: { lang: ["fr"] } })
  assert.deepEqual(page.documents.map((d) => d.ark), [ARK(1)])
})

test("the buffer language bound is THIS project's buffer — not another project's", async () => {
  await assert.rejects(BufferService.candidateArks(mine.id, { not: { lang: ["it"] } }), FilterValueError)
  assert.deepEqual(await BufferService.candidateArks(mine.id, { lang: ["fr"] }), [ARK(5)])
})
