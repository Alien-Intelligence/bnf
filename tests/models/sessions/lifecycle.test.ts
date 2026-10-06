// tests/models/sessions/lifecycle.test.ts
// SessionService over SessionQueries: creation status and title, the default
// session per scope, the placeholder-guarded auto title, and archiving out of
// the project's list.
import "server-only"

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { Project, User } from "@/lib/generated/prisma/client"
import { DEFAULT_SESSION_TITLE, FIRST_SESSION_TITLE } from "@/lib/constants"
import { createTestProject, createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { SessionQueries } from "@/models/sessions/queries"
import { SESSION_SCOPE, SESSION_STATUS } from "@/models/sessions/schema"
import { SessionService } from "@/models/sessions/service"

let owner: User
let project: Project

before(async () => {
  owner = await createTestUser()
  project = await createTestProject(owner.id, "session-lifecycle")
})

after(async () => {
  await cleanupProject(project.id)
  await deleteTestUser(owner.id)
})

test("a created session is active and wears the placeholder title", async () => {
  const session = await SessionService.create(project.id, SESSION_SCOPE.RESEARCH)
  assert.equal(session.status, SESSION_STATUS.ACTIVE)
  assert.equal(session.title, DEFAULT_SESSION_TITLE)
})

test("ensureDefaultForScope creates the first session once, then returns it", async () => {
  const first = await SessionService.ensureDefaultForScope(project.id, SESSION_SCOPE.CORPUS)
  assert.equal(first.title, FIRST_SESSION_TITLE)
  const again = await SessionService.ensureDefaultForScope(project.id, SESSION_SCOPE.CORPUS)
  assert.equal(again.id, first.id)
})

test("the placeholder guard never overwrites a rename", async () => {
  const session = await SessionService.create(project.id, SESSION_SCOPE.RESEARCH)
  await SessionService.rename(session.id, "Renommée à la main")
  await SessionQueries.setTitleIfPlaceholder(session.id, "Titre généré", [DEFAULT_SESSION_TITLE])
  assert.equal(await SessionQueries.titleOf(session.id), "Renommée à la main")

  const fresh = await SessionService.create(project.id, SESSION_SCOPE.RESEARCH)
  await SessionQueries.setTitleIfPlaceholder(fresh.id, "Titre généré", [DEFAULT_SESSION_TITLE])
  assert.equal(await SessionQueries.titleOf(fresh.id), "Titre généré")
})

test("an archived session leaves the project's list", async () => {
  const session = await SessionService.create(project.id, SESSION_SCOPE.RESEARCH)
  await SessionService.archive(session.id)
  const listed = await SessionQueries.listForProject(project.id, SESSION_SCOPE.RESEARCH)
  assert.ok(!listed.some((s) => s.id === session.id))
  assert.equal((await SessionQueries.get(session.id))?.status, SESSION_STATUS.ARCHIVED)
})
