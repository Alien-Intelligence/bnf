// tests/models/undated-parity.test.ts
// `undated` means ONE thing in the buffer and in the corpus: with a range it
// widens the range to the undated rows; alone it selects them; under `not`
// the exclusion is the exact complement (Decision 4). So a saved filter set
// selects the same documents before a commit (in the buffer) and after it
// (in the corpus).
import "server-only"

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { Project, User } from "@/lib/generated/prisma/client"
import { prisma } from "@/lib/db"
import { createTestProject, createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { BufferService } from "@/models/buffer/service"
import type { BufferFilterSet } from "@/models/buffer/types"
import { CorpusService } from "@/models/corpus/service"
import { DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"

let user: User
let project: Project

const ARK = (n: number) => `ark:/12148/bpt6k96${String(n).padStart(5, "0")}`
const ROWS: Array<{ ark: string; year: number | null }> = [
  { ark: ARK(1), year: 1890 },
  { ark: ARK(2), year: 1937 },
  { ark: ARK(3), year: 1960 },
  { ark: ARK(4), year: null },
  { ark: ARK(5), year: null },
]

/** The saved sets: every combination of a range and `undated`, plain and under `not`. */
const SETS: BufferFilterSet[] = [
  { yearFrom: 1900, yearTo: 1950 },
  { yearFrom: 1900, yearTo: 1950, undated: true },
  { undated: true },
  { yearFrom: 1930, undated: true },
  { not: { yearFrom: 1900, yearTo: 1950 } },
  { not: { yearFrom: 1900, yearTo: 1950, undated: true } },
  { not: { undated: true } },
]

let bufferSelections: string[][] = []

before(async () => {
  user = await createTestUser()
  project = await createTestProject(user.id, "undated-parity")
  // The documents as the resolver would leave them, so the commit adds them resolved.
  await prisma.document.createMany({
    data: ROWS.map((r) => ({
      ark: r.ark,
      projectId: project.id,
      title: `Doc ${r.ark}`,
      year: r.year,
      source: "gallica",
      resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
    })),
  })
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: ROWS.map((r) => ({ ark: r.ark, title: `Doc ${r.ark}`, ...(r.year !== null ? { year: r.year } : {}) })),
  })
  bufferSelections = await Promise.all(SETS.map(async (f) => (await BufferService.candidateArks(project.id, f)).sort()))
  await BufferService.commit(project, user, { reason: "parity" })
})

after(async () => {
  await cleanupProject(project.id)
  await deleteTestUser(user.id)
})

test("every saved set selects the same documents in the buffer before commit and in the corpus after", async () => {
  for (const [i, filters] of SETS.entries()) {
    const inCorpus = (await CorpusService.arksMatchingFilters(project.id, "head", filters)).sort()
    assert.deepEqual(inCorpus, bufferSelections[i], `set ${JSON.stringify(filters)}`)
  }
})

test("with a range, undated:true widens the range in both stores; `not` is its exact complement", async () => {
  const widened = (await CorpusService.arksMatchingFilters(project.id, "head", { yearFrom: 1900, yearTo: 1950, undated: true })).sort()
  assert.deepEqual(widened, [ARK(2), ARK(4), ARK(5)])
  const complement = (
    await CorpusService.arksMatchingFilters(project.id, "head", { not: { yearFrom: 1900, yearTo: 1950, undated: true } })
  ).sort()
  assert.deepEqual(complement, [ARK(1), ARK(3)])
  const notUnknown = await CorpusService.notUnknownCounts(project.id, "head", { not: { yearFrom: 1900, yearTo: 1950, undated: true } })
  assert.deepEqual(notUnknown, {}, "an undated document is matched, not unknown")
})
