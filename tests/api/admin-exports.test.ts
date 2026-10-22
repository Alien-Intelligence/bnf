// tests/api/admin-exports.test.ts
// The four admin CSV exports (accounts, feedback, OCR, usage) are admin-only,
// decided by UserPolicy.exportAdminData through the bouncer: a member gets the
// 403 envelope, an admin gets the CSV. The usage export's per-project totals
// (all-time and trailing window) are pinned against known message fixtures.
// The routes are driven for real; only the better-auth session lookup is
// replaced, since a signed cookie is not what is under test.
import "server-only"

import { test, before, after, mock } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db"
import { auth } from "@/lib/auth"
import type { Project, User } from "@/lib/generated/prisma/client"
import { USAGE_EXPORT_WINDOW_MS } from "@/lib/constants"
import { csvRow } from "@/lib/csv"
import { createTestUser, createTestProject, createTestSession, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { MESSAGE_ROLE, MESSAGE_STATUS } from "@/models/messages/schema"
import { MessageService } from "@/models/messages/service"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import { USER_ROLE } from "@/models/users/schema"
import { GET as accountsExport } from "@/app/api/admin/accounts/export/route"
import { GET as feedbackExport } from "@/app/api/admin/feedback/export/route"
import { GET as ocrExport } from "@/app/api/admin/ocr/export/route"
import { GET as usageExport } from "@/app/api/admin/usage/export/route"

let admin: User
let member: User
let project: Project
let actingUserId: string

const NOW = new Date("2026-10-22T12:00:00.000Z")
const INSIDE_WINDOW = new Date(NOW.getTime() - USAGE_EXPORT_WINDOW_MS + 60_000)
const OUTSIDE_WINDOW = new Date(NOW.getTime() - USAGE_EXPORT_WINDOW_MS - 60_000)

const ROUTES = [
  { name: "accounts", GET: accountsExport, header: "user_id,name,email,role" },
  { name: "feedback", GET: feedbackExport, header: "feedback_id,created_at,rating,target" },
  { name: "ocr", GET: ocrExport, header: "job_id,project_id,project_name,status" },
  { name: "usage", GET: usageExport, header: "project_id,project_name,owner_id,owner_email" },
] as const

before(async () => {
  admin = await createTestUser()
  await prisma.user.update({ where: { id: admin.id }, data: { role: USER_ROLE.ADMIN } })
  member = await createTestUser()
  await prisma.user.update({ where: { id: member.id }, data: { role: USER_ROLE.MEMBER } })
  project = await createTestProject(member.id, "admin-exports")

  const sessionId = await createTestSession(project.id, SESSION_SCOPE.RESEARCH)
  const message = (seq: number, createdAt: Date, usage: object | undefined) => ({
    id: randomUUID(),
    appSessionId: sessionId,
    seq,
    role: seq === 1 ? MESSAGE_ROLE.USER : MESSAGE_ROLE.ASSISTANT,
    status: MESSAGE_STATUS.DONE,
    createdAt,
    usage,
  })
  await prisma.message.createMany({
    data: [
      message(1, INSIDE_WINDOW, undefined),
      message(2, INSIDE_WINDOW, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 }),
      message(3, OUTSIDE_WINDOW, { inputTokens: 50, outputTokens: 10 }),
      message(4, INSIDE_WINDOW, {}),
    ],
  })

  mock.method(auth.api, "getSession", async () => ({
    session: { id: "test-session" },
    user: { id: actingUserId },
  }))
})

after(async () => {
  mock.restoreAll()
  await cleanupProject(project.id)
  await deleteTestUser(member.id)
  await deleteTestUser(admin.id)
})

for (const { name, GET, header } of ROUTES) {
  test(`${name} export: a member gets the 403 envelope`, async () => {
    actingUserId = member.id
    const res = await GET(new Request(`http://localhost/api/admin/${name}/export`), undefined)
    assert.equal(res.status, 403)
    assert.deepEqual(await res.json(), { error: "Forbidden" })
  })

  test(`${name} export: an admin gets the CSV`, async () => {
    actingUserId = admin.id
    const res = await GET(new Request(`http://localhost/api/admin/${name}/export`), undefined)
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type") ?? "", /^text\/csv/)
    assert.ok((await res.text()).startsWith(header))
  })
}

test("usage totals: all-time, trailing window, and only messages that carry usage", async () => {
  const totals = await MessageService.projectUsageTotals(NOW)
  const mine = totals.find((t) => t.projectId === project.id)
  assert.deepEqual(mine, {
    projectId: project.id,
    projectName: project.name,
    ownerId: member.id,
    ownerEmail: member.email,
    tokensIn: 150,
    tokensOut: 30,
    messageCount: 3,
    windowTokensIn: 100,
    windowTokensOut: 20,
  })
})

test("usage export: the project's row carries those totals", async () => {
  actingUserId = admin.id
  const res = await usageExport(new Request("http://localhost/api/admin/usage/export"), undefined)
  const lines = (await res.text()).split("\r\n")
  const row = lines.find((l) => l.startsWith(project.id))
  assert.ok(row, "the project has a row")
  // The export's window ends at the request's own clock, so only the columns
  // that do not depend on it are pinned; the windowed ones are pinned above.
  assert.ok(row.startsWith(csvRow([project.id, project.name, member.id, member.email, 150, 30, 3])))
})

test("a usage value of the wrong shape is a corrupt row, not zero tokens", async () => {
  const sessionId = (await prisma.appSession.findFirstOrThrow({ where: { projectId: project.id } })).id
  await prisma.message.create({
    data: {
      id: randomUUID(),
      appSessionId: sessionId,
      seq: 5,
      role: MESSAGE_ROLE.ASSISTANT,
      status: MESSAGE_STATUS.DONE,
      usage: { inputTokens: "many" },
    },
  })
  await assert.rejects(MessageService.projectUsageTotals(NOW))
})
