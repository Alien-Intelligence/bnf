// tests/models/corpus/swap-canonical-notices.test.ts
// CorpusService.swapCanonicalNotices: the canonicalizer's catalogue-notice →
// Gallica-document swap, in ONE new version written by the system actor. A
// notice the librarian removed meanwhile is not resurrected as its Gallica doc,
// a canonical already in the corpus is not added twice, and every upgraded
// notice's pending status is cleared in the same transaction.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { createTestUser, createTestProject, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { CorpusQueries } from "@/models/corpus/queries"
import { CORPUS_SYSTEM_ACTOR } from "@/models/corpus/schema"
import { CorpusService } from "@/models/corpus/service"
import { DOCUMENT_CANONICAL_STATUS, DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"

let user: User
let project: Project

const NOTICE_A = "ark:/12148/cb93000001a"
const NOTICE_B = "ark:/12148/cb93000002b"
const NOTICE_REMOVED = "ark:/12148/cb93000003c"
const GALLICA_A = "ark:/12148/bpt6k9400001"
const GALLICA_B = "ark:/12148/bpt6k9400002"
const GALLICA_REMOVED = "ark:/12148/bpt6k9400003"

before(async () => {
  user = await createTestUser()
  project = await createTestProject(user.id, "swap-canonical")
  await prisma.document.createMany({
    data: [
      { ark: NOTICE_A, source: "catalogue", canonicalStatus: DOCUMENT_CANONICAL_STATUS.PENDING },
      { ark: NOTICE_B, source: "catalogue", canonicalStatus: DOCUMENT_CANONICAL_STATUS.PENDING },
      { ark: NOTICE_REMOVED, source: "catalogue", canonicalStatus: DOCUMENT_CANONICAL_STATUS.PENDING },
      { ark: GALLICA_A, source: "gallica", canonicalStatus: null },
      { ark: GALLICA_B, source: "gallica", canonicalStatus: null },
      { ark: GALLICA_REMOVED, source: "gallica", canonicalStatus: null },
    ].map((d) => ({
      ...d,
      projectId: project.id,
      title: d.ark,
      resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
    })),
  })
  // GALLICA_B is already a member (added independently); NOTICE_REMOVED was
  // added then removed by the librarian before the swap runs.
  await CorpusService.addArks(project, user, {
    arks: [NOTICE_A, NOTICE_B, NOTICE_REMOVED, GALLICA_B],
    reason: "fixture",
  })
  await CorpusService.removeArks(project, user, { arks: [NOTICE_REMOVED], reason: "fixture" })
})

after(async () => {
  await cleanupProject(project.id)
  await deleteTestUser(user.id)
})

test("swaps member notices in one system version, skipping removed notices and existing canonicals", async () => {
  const before = await CorpusQueries.headVersion(project.id)

  const swapped = await CorpusService.swapCanonicalNotices(
    project.id,
    new Map([
      [NOTICE_A, GALLICA_A],
      [NOTICE_B, GALLICA_B],
      [NOTICE_REMOVED, GALLICA_REMOVED],
    ]),
  )

  assert.equal(swapped, 2, "only the two notices still in the head are swapped")
  const head = await CorpusQueries.headVersion(project.id)
  assert.equal(head.seq, before.seq + 1, "exactly one new version")
  assert.equal(head.createdBy, CORPUS_SYSTEM_ACTOR.CANONICALIZE)

  const members = new Set(head.membership.map((m) => m.ark))
  assert.deepEqual(
    [...members].sort(),
    [GALLICA_A, GALLICA_B].sort(),
    "notices replaced by their Gallica docs; the removed notice's doc not resurrected",
  )
  assert.equal(
    head.membership.filter((m) => m.ark === GALLICA_B).length,
    1,
    "a canonical already in the corpus is not added twice",
  )

  const notices = await prisma.document.findMany({
    where: { projectId: project.id, ark: { in: [NOTICE_A, NOTICE_B, NOTICE_REMOVED] } },
    select: { ark: true, canonicalStatus: true },
  })
  for (const n of notices) assert.equal(n.canonicalStatus, null, `${n.ark} is no longer queued`)
})
