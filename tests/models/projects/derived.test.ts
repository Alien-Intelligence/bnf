// models/projects/derived.test.ts
// Derived projects — read-only corpus consumption — against the real dev
// Postgres. What is asserted here is what a silent failure would hide: that a
// workspace cannot be built on a corpus the caller has no grant on, nor on one
// that was never ingested, and that revoking the grant degrades the workspace
// to a legible state instead of deleting it.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db"
import type { User } from "@/lib/generated/prisma/client"
import {
  NoCorpusGrantError,
  ProjectService,
  SourceIsDerivedError,
  SourceNotIngestedError,
} from "@/models/projects/service"
import { ProjectQueries } from "@/models/projects/queries"
import { markHeadIngested } from "@/lib/testing/mark-ingested"
import { ProjectSharingService } from "@/models/projects/service"
import { PROJECT_ACCESS } from "@/lib/authz/project-access"
import {
  CORPUS_SOURCE_STATE,
  canReachCorpus,
  corpusProjectId,
  corpusSourceState,
} from "@/lib/authz/corpus-source"
import type { PolicyUser } from "@/models/users/schema"
import {
  createTestUser,
  createTestProject,
  deleteTestUser,
} from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"

let owner: User
let reader: User
let groupId: string
const projects: string[] = []
const otherGroups: string[] = []

function policyUser(user: User, groupIds: string[] = []): PolicyUser {
  return { ...user, groupIds }
}

/** A project owned by `owner`, registered for teardown. */
async function freshProject(label: string) {
  const p = await createTestProject(owner.id, label)
  projects.push(p.id)
  return p
}


before(async () => {
  owner = await createTestUser()
  reader = await createTestUser()
  const group = await prisma.group.create({
    data: { name: `TEST derived ${randomUUID()}`, slug: `test-derived-${randomUUID()}` },
  })
  groupId = group.id
  await prisma.groupMember.create({ data: { groupId, userId: reader.id } })
})

after(async () => {
  // Children first: the Restrict FK on corpusSourceId is exactly what stops a
  // source being deleted while a derived project reads it.
  const ordered = [...projects].reverse()
  for (const id of ordered) await cleanupProject(id)
  await prisma.group.deleteMany({ where: { id: { in: [groupId, ...otherGroups] } } })
  await deleteTestUser(owner.id)
  await deleteTestUser(reader.id)
})

// --- refusals --------------------------------------------------------------

test("createDerived refuses without a share on the source", async () => {
  const source = await freshProject("no grant")
  await markHeadIngested(source.id)

  const loaded = await ProjectQueries.get(source.id)
  await assert.rejects(
    () =>
      ProjectService.createDerived({
        source: loaded!,
        user: policyUser(reader),
        name: "Espace sans partage",
      }),
    NoCorpusGrantError,
  )
})

test("createDerived refuses a source that was never ingested", async () => {
  const source = await freshProject("never ingested")
  await ProjectSharingService.share(
    (await ProjectQueries.get(source.id))!,
    owner.id,
    { groupId, access: PROJECT_ACCESS.READ },
  )

  const loaded = await ProjectQueries.get(source.id)
  await assert.rejects(
    () =>
      ProjectService.createDerived({
        source: loaded!,
        user: policyUser(reader, [groupId]),
        name: "Espace sur corpus vide",
      }),
    SourceNotIngestedError,
  )
})

// --- the happy path --------------------------------------------------------

test("createDerived pins the workspace to the grant and keeps its own head", async () => {
  const source = await freshProject("derive ok")
  await markHeadIngested(source.id)
  const shares = await ProjectSharingService.share(
    (await ProjectQueries.get(source.id))!,
    owner.id,
    { groupId, access: PROJECT_ACCESS.READ },
  )

  const derived = await ProjectService.createDerived({
    source: (await ProjectQueries.get(source.id))!,
    user: policyUser(reader, [groupId]),
    name: "Espace de recherche",
  })
  projects.push(derived.id)

  assert.equal(derived.corpusSourceId, source.id)
  assert.equal(derived.corpusSourceShareId, shares[0]!.id)
  assert.equal(derived.ownerId, reader.id)
  // Corpus-versioning invariant 1 holds for every project, derived included.
  assert.ok(derived.headVersionId, "a derived project still has a head version")

  assert.equal(corpusProjectId(derived), source.id)
  assert.equal(corpusSourceState(derived), CORPUS_SOURCE_STATE.SHARED)
})

test("createDerived refuses to derive from a derived project", async () => {
  const source = await freshProject("chain root")
  await markHeadIngested(source.id)
  await ProjectSharingService.share(
    (await ProjectQueries.get(source.id))!,
    owner.id,
    { groupId, access: PROJECT_ACCESS.READ },
  )

  const derived = await ProjectService.createDerived({
    source: (await ProjectQueries.get(source.id))!,
    user: policyUser(reader, [groupId]),
    name: "Premier niveau",
  })
  projects.push(derived.id)

  const loadedDerived = await ProjectQueries.get(derived.id)
  await assert.rejects(
    () =>
      ProjectService.createDerived({
        source: loadedDerived!,
        user: policyUser(reader, [groupId]),
        name: "Second niveau",
      }),
    SourceIsDerivedError,
  )
})

// --- revocation and deletion ------------------------------------------------

test("revoking the share leaves the workspace intact in the revoked state", async () => {
  const source = await freshProject("revoke")
  await markHeadIngested(source.id)
  await ProjectSharingService.share(
    (await ProjectQueries.get(source.id))!,
    owner.id,
    { groupId, access: PROJECT_ACCESS.READ },
  )

  const derived = await ProjectService.createDerived({
    source: (await ProjectQueries.get(source.id))!,
    user: policyUser(reader, [groupId]),
    name: "Espace révocable",
  })
  projects.push(derived.id)

  // A note the reader wrote must outlive the grant — losing corpus access is
  // not losing your own work.
  await prisma.note.create({
    data: { projectId: derived.id, title: "Note du chercheur", body_md: "…" },
  })

  await ProjectSharingService.unshare(source.id, groupId)

  const after = await prisma.project.findUniqueOrThrow({
    where: { id: derived.id },
  })
  assert.equal(after.corpusSourceId, source.id, "still points at its source")
  assert.equal(after.corpusSourceShareId, null, "the grant is gone")
  assert.equal(corpusSourceState(after), CORPUS_SOURCE_STATE.REVOKED)
  assert.equal(canReachCorpus(after), false)
  assert.equal(
    await prisma.note.count({ where: { projectId: derived.id } }),
    1,
    "the notes survive",
  )
})

test("re-sharing re-attaches a workspace the revoke had orphaned", async () => {
  const source = await freshProject("re-share heals")
  await markHeadIngested(source.id)
  await ProjectSharingService.share(
    (await ProjectQueries.get(source.id))!,
    owner.id,
    { groupId, access: PROJECT_ACCESS.READ },
  )

  const derived = await ProjectService.createDerived({
    source: (await ProjectQueries.get(source.id))!,
    user: policyUser(reader, [groupId]),
    name: "Espace réparable",
  })
  projects.push(derived.id)

  await ProjectSharingService.unshare(source.id, groupId)
  assert.equal(
    corpusSourceState(
      await prisma.project.findUniqueOrThrow({ where: { id: derived.id } }),
    ),
    CORPUS_SOURCE_STATE.REVOKED,
  )

  // Re-sharing creates a NEW share row, so the workspace has to be re-pointed
  // at it — otherwise an accidental revoke would be permanent.
  const reshared = await ProjectSharingService.share(
    (await ProjectQueries.get(source.id))!,
    owner.id,
    { groupId, access: PROJECT_ACCESS.WRITE },
  )

  const healed = await prisma.project.findUniqueOrThrow({
    where: { id: derived.id },
  })
  assert.equal(healed.corpusSourceShareId, reshared[0]!.id, "pinned to the new grant")
  assert.equal(corpusSourceState(healed), CORPUS_SOURCE_STATE.SHARED)
  assert.equal(canReachCorpus(healed), true)
})

test("re-sharing to a group the workspace's owner is NOT in leaves it revoked", async () => {
  const source = await freshProject("re-share other group")
  await markHeadIngested(source.id)
  await ProjectSharingService.share(
    (await ProjectQueries.get(source.id))!,
    owner.id,
    { groupId, access: PROJECT_ACCESS.READ },
  )
  const derived = await ProjectService.createDerived({
    source: (await ProjectQueries.get(source.id))!,
    user: policyUser(reader, [groupId]),
    name: "Espace non réparé",
  })
  projects.push(derived.id)
  await ProjectSharingService.unshare(source.id, groupId)

  // A grant to a group the reader does not belong to gives them nothing, so it
  // must not silently resurrect their workspace.
  const otherGroup = await prisma.group.create({
    data: { name: `TEST other ${randomUUID()}`, slug: `test-other-${randomUUID()}` },
  })
  otherGroups.push(otherGroup.id)
  await ProjectSharingService.share(
    (await ProjectQueries.get(source.id))!,
    owner.id,
    { groupId: otherGroup.id, access: PROJECT_ACCESS.READ },
  )

  const still = await prisma.project.findUniqueOrThrow({ where: { id: derived.id } })
  assert.equal(corpusSourceState(still), CORPUS_SOURCE_STATE.REVOKED)
})

test("a source cannot be deleted while a derived project reads it", async () => {
  const source = await freshProject("restrict")
  await markHeadIngested(source.id)
  await ProjectSharingService.share(
    (await ProjectQueries.get(source.id))!,
    owner.id,
    { groupId, access: PROJECT_ACCESS.READ },
  )

  const derived = await ProjectService.createDerived({
    source: (await ProjectQueries.get(source.id))!,
    user: policyUser(reader, [groupId]),
    name: "Espace dépendant",
  })
  projects.push(derived.id)

  assert.equal(await ProjectQueries.derivedCount(source.id), 1)

  // onDelete: Restrict — the database refuses, so no code path can orphan a
  // workspace whose notes cite ARKs it could no longer open.
  await assert.rejects(() => cleanupProject(source.id))
})

test("the CHECK constraint forbids a share id with no source", async () => {
  const p = await freshProject("check constraint")

  await assert.rejects(
    () =>
      prisma.$executeRaw`UPDATE "project" SET "corpus_source_share_id" = 'nonsense' WHERE id = ${p.id}`,
    /project_corpus_source_share_requires_source|violates/i,
  )
})
