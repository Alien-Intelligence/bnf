// models/groups/service.test.ts
// GroupService against the real dev Postgres. The invariants that matter here
// are the ones a silent failure would hide: adding an unknown address must not
// look like success, re-adding must not duplicate, and deleting a group must
// take its memberships and its shares with it.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db"
import type { User } from "@/lib/generated/prisma/client"
import { GroupService } from "./service"
import { GroupQueries } from "./queries"
import {
  GroupSlugTakenError,
  InvalidGroupNameError,
  UserNotFoundError,
  slugifyGroupName,
} from "./schema"
import { PROJECT_ACCESS } from "@/lib/authz/project-access"
import {
  createTestUser,
  createTestProject,
  deleteTestUser,
} from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"

let user: User
const groups: string[] = []
const projects: string[] = []

/** A uniquely-named group registered for teardown. */
async function freshGroup(label: string) {
  const group = await GroupService.create(`TEST ${label} ${randomUUID()}`)
  groups.push(group.id)
  return group
}

before(async () => {
  user = await createTestUser()
})

after(async () => {
  for (const id of projects) await cleanupProject(id)
  await prisma.group.deleteMany({ where: { id: { in: groups } } })
  await deleteTestUser(user.id)
})

// --- slugs -----------------------------------------------------------------

test("slugifyGroupName strips diacritics and collapses separators", () => {
  assert.equal(
    slugifyGroupName("Département   Recherche & Numérisation"),
    "departement-recherche-numerisation",
  )
})

test("slugifyGroupName throws rather than returning an empty slug", () => {
  // An empty slug would collide with every other empty slug and is never what
  // the caller meant — refusing is the only honest answer.
  assert.throws(() => slugifyGroupName("!!! ---"), InvalidGroupNameError)
})

test("create refuses a name whose slug is already taken", async () => {
  const group = await freshGroup("slug clash")
  await assert.rejects(
    () => GroupService.create(group.name),
    GroupSlugTakenError,
  )
})

test("rename re-derives the slug and allows renaming to the same name", async () => {
  const group = await freshGroup("rename")
  const renamed = await GroupService.rename(group.id, "Cabinet des Estampes")

  assert.equal(renamed.slug, "cabinet-des-estampes")
  // Renaming a group to what it is already called must not trip its own slug.
  const again = await GroupService.rename(group.id, "Cabinet des Estampes")
  assert.equal(again.slug, "cabinet-des-estampes")
})

// --- membership ------------------------------------------------------------

test("addMemberByEmail throws on an address that matches no account", async () => {
  const group = await freshGroup("unknown email")

  await assert.rejects(
    () => GroupService.addMemberByEmail(group.id, "nobody@bnf-unit.local"),
    UserNotFoundError,
  )

  const roster = await GroupQueries.withMembers(group.id)
  assert.equal(roster?.members.length, 0, "nothing was added")
})

test("adding the same member twice is idempotent", async () => {
  const group = await freshGroup("idempotent add")

  await GroupService.addMemberByEmail(group.id, user.email)
  await GroupService.addMemberByEmail(group.id, user.email)

  const roster = await GroupQueries.withMembers(group.id)
  assert.equal(roster?.members.length, 1)
})

test("groupIdsForUser reflects add and remove immediately", async () => {
  const group = await freshGroup("group ids")

  await GroupService.addMemberByEmail(group.id, user.email)
  assert.ok(
    (await GroupQueries.groupIdsForUser(user.id)).includes(group.id),
    "membership is visible to the next request's PolicyUser",
  )

  await GroupService.removeMember(group.id, user.id)
  assert.equal(
    (await GroupQueries.groupIdsForUser(user.id)).includes(group.id),
    false,
    "removal revokes access on the next request",
  )
})

test("removing a non-member is a no-op, not an error", async () => {
  const group = await freshGroup("remove non-member")
  await GroupService.removeMember(group.id, user.id)
})

// --- cascade ---------------------------------------------------------------

test("deleting a group cascades its members and its project shares", async () => {
  const group = await freshGroup("cascade")
  const project = await createTestProject(user.id, "group cascade")
  projects.push(project.id)

  await GroupService.addMemberByEmail(group.id, user.email)
  await prisma.projectShare.create({
    data: {
      projectId: project.id,
      groupId: group.id,
      access: PROJECT_ACCESS.READ,
      createdBy: user.id,
    },
  })

  await GroupService.delete(group.id)

  assert.equal(await prisma.groupMember.count({ where: { groupId: group.id } }), 0)
  assert.equal(await prisma.projectShare.count({ where: { groupId: group.id } }), 0)
  assert.ok(
    await prisma.project.findUnique({ where: { id: project.id } }),
    "the project itself survives — only the grant is gone",
  )
})
