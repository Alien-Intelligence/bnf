// lib/agent/tools/refusal.test.ts
// The refusal convention: a refused or failed tool call returns
// `{ success: false, … }`, which is what the chip, the flat mapper and the
// persistence adapter key on (toolCallErrored). Before this, an empty
// remove-by-filter came back as `{ status: "empty_filter" }`, was persisted as
// `status: "ok"`, and rendered a ✓ for a call that did nothing.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { createTestUser, createTestProject, createTestSession, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { corpusRemoveByFilterView, toolCallErrored } from "@/lib/tools/display"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import type { PolicyUser } from "@/models/users/schema"
import { bufferRemoveByFilterTool } from "./buffer"
import { corpusDiffTool, corpusGetStateTool, corpusListTool, corpusRemoveByFilterTool, corpusStatsTool } from "./corpus"
import { CORPUS_ACCESS_REVOKED_ERROR } from "./ingestion-guard"
import { EMPTY_FILTER_REFUSAL } from "./failure"
import { noteGetTool } from "./note"
import type { TurnScopedCtx } from "./registry-factory"

let ownerRow: User
let owner: PolicyUser
let project: Project
let corpusSession: string

function ctx(): TurnScopedCtx {
  return {
    signal: new AbortController().signal,
    request: new Request("http://localhost/test"),
    db: prisma,
    user: owner,
    appSessionId: corpusSession,
    projectId: project.id,
    corpusProjectId: project.id,
    corpusReachable: true,
    scope: SESSION_SCOPE.CORPUS,
  }
}

before(async () => {
  ownerRow = await createTestUser()
  owner = { ...ownerRow, groupIds: [] }
  project = await createTestProject(ownerRow.id, "refusal")
  corpusSession = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
})

after(async () => {
  await cleanupProject(project.id)
  await deleteTestUser(ownerRow.id)
})

for (const [name, call] of [
  ["buffer_remove_by_filter", () => bufferRemoveByFilterTool.handler({ filters: {}, dry_run: false }, ctx())],
  ["corpus_remove_by_filter", () => corpusRemoveByFilterTool.handler({ filters: {}, reason: "test", dry_run: false }, ctx())],
] as const) {
  test(`${name} refuses an empty filter as a success:false result the UI counts as failed`, async () => {
    const result = await call()
    assert.ok(typeof result === "object" && result !== null)
    assert.equal("success" in result && result.success, false)
    assert.equal("refused" in result && result.refused, EMPTY_FILTER_REFUSAL)
    assert.match("error" in result && typeof result.error === "string" ? result.error : "", /Filtre vide refusé/)

    const persisted = JSON.stringify(result)
    assert.equal(toolCallErrored(false, persisted), true, "persisted as an error, not ✓")
    assert.deepEqual(corpusRemoveByFilterView(persisted), { status: "empty_filter" }, "the pill still names it")
  })
}

test("note_get on an unknown id fails with success:false", async () => {
  const result = await noteGetTool.handler({ id: "00000000-0000-4000-8000-000000000000" }, ctx())
  assert.equal(toolCallErrored(false, JSON.stringify(result)), true)
})

test("the corpus read tools refuse when the derived workspace's grant was revoked", async () => {
  const revoked: TurnScopedCtx = { ...ctx(), corpusReachable: false }
  for (const call of [
    () => corpusGetStateTool.handler({}, revoked),
    () => corpusListTool.handler({}, revoked),
    () => corpusStatsTool.handler({}, revoked),
    () => corpusDiffTool.handler({ from_seq: 1, to_seq: 1 }, revoked),
  ]) {
    const result = await call()
    assert.equal(toolCallErrored(false, JSON.stringify(result)), true)
    assert.match(JSON.stringify(result), new RegExp(CORPUS_ACCESS_REVOKED_ERROR.slice(0, 30)))
  }
})

test("the corpus read tools read the corpus the turn reads (corpusProjectId), not the workspace", async () => {
  const source = await createTestProject(ownerRow.id, "refusal-source")
  try {
    const derived: TurnScopedCtx = { ...ctx(), corpusProjectId: source.id }
    const result = await corpusGetStateTool.handler({ include_sample: false }, derived)
    assert.ok(typeof result === "object" && result !== null && "versionSeq" in result, JSON.stringify(result))
  } finally {
    await cleanupProject(source.id)
  }
})
