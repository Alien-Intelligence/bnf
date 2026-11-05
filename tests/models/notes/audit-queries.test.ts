// The reads the quote audit and the e2e harness make: a project's notes with
// their bodies, oldest first; notes by id; and the audit's project rows.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import { NoteQueries } from "@/models/notes/queries"
import { ProjectQueries } from "@/models/projects/queries"
import { createTestProject, createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"

let userId: string
let projectId: string
let otherProjectId: string
let firstId: string
let secondId: string

before(async () => {
  userId = (await createTestUser()).id
  projectId = (await createTestProject(userId, "audit-queries")).id
  otherProjectId = (await createTestProject(userId, "audit-queries-other")).id
  const first = await prisma.note.create({
    data: { projectId, title: "first", body_md: "body one", createdAt: new Date("2026-01-01T00:00:00Z") },
  })
  const second = await prisma.note.create({
    data: { projectId, title: "second", body_md: "body two", createdAt: new Date("2026-01-02T00:00:00Z") },
  })
  await prisma.note.create({ data: { projectId: otherProjectId, title: "elsewhere", body_md: "x" } })
  firstId = first.id
  secondId = second.id
})
after(async () => {
  await cleanupProject(otherProjectId)
  await cleanupProject(projectId)
  await deleteTestUser(userId)
})

test("listBodiesForProject returns this project's notes with id, title and body, oldest first", async () => {
  assert.deepEqual(await NoteQueries.listBodiesForProject(projectId), [
    { id: firstId, title: "first", body_md: "body one" },
    { id: secondId, title: "second", body_md: "body two" },
  ])
})

test("bodiesByIds returns the asked notes only; an unknown id is absent", async () => {
  const rows = await NoteQueries.bodiesByIds([secondId, "00000000-0000-0000-0000-000000000000"])
  assert.deepEqual(rows, [{ id: secondId, body_md: "body two" }])
})

test("listForAudit narrows to one project, or lists every project oldest first, with the corpus-source fields", async () => {
  const one = await ProjectQueries.listForAudit(projectId)
  assert.equal(one.length, 1)
  assert.deepEqual(Object.keys(one[0]).sort(), ["corpusSourceId", "corpusSourceShareId", "id", "name"])
  assert.equal(one[0].id, projectId)
  const all = await ProjectQueries.listForAudit(null)
  const ids = all.map((p) => p.id)
  assert.ok(ids.includes(projectId) && ids.includes(otherProjectId))
  assert.ok(ids.indexOf(projectId) < ids.indexOf(otherProjectId), "oldest first")
})
