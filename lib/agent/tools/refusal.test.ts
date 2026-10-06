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
import { bufferListTool, bufferRemoveByFilterTool, corpusSearchTool } from "./buffer"
import { corpusDiffTool, corpusGetStateTool, corpusListTool, corpusRemoveByFilterTool, corpusStatsTool } from "./corpus"
import { CORPUS_ACCESS_REVOKED_ERROR } from "./ingestion-guard"
import { EMPTY_FILTER_REFUSAL, INVALID_PARAMS_REFUSAL } from "./failure"
import { noteGetTool } from "./note"
import { ragGetTextTool, ragKeywordSearchTool, ragQueryTool } from "./rag"
import { memoryWriteTool } from "./memory"
import { TOOL_PROJECT_GONE_ERROR } from "./authorize"
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

test("corpus_search refuses parameters it cannot honour in the one refusal shape, with an error", async () => {
  // No criterion at all: refused before any BnF egress.
  const result = await corpusSearchTool.handler({ source: "gallica" }, ctx())
  assert.ok(typeof result === "object" && result !== null)
  assert.equal("success" in result && result.success, false)
  assert.equal("refused" in result && result.refused, INVALID_PARAMS_REFUSAL)
  assert.match("error" in result && typeof result.error === "string" ? result.error : "", /Paramètres de recherche refusés/)
  assert.ok("problems" in result && Array.isArray(result.problems) && result.problems.length === 1, "the fixes travel along")
  assert.equal(toolCallErrored(false, JSON.stringify(result)), true)
})

test("a filter language the store does not hold is an invalid_params refusal, never a throw", async () => {
  for (const call of [
    () => bufferListTool.handler({ filters: { not: { lang: ["xx"] } } }, ctx()),
    () => bufferRemoveByFilterTool.handler({ filters: { not: { lang: ["xx"] } }, dry_run: true }, ctx()),
    () => corpusListTool.handler({ filters: { not: { lang: ["xx"] } } }, ctx()),
    () => corpusRemoveByFilterTool.handler({ filters: { not: { lang: ["xx"] } }, reason: "test", dry_run: true }, ctx()),
  ]) {
    const result = await call()
    assert.ok(typeof result === "object" && result !== null)
    assert.equal("refused" in result && result.refused, INVALID_PARAMS_REFUSAL, JSON.stringify(result))
    assert.match("error" in result && typeof result.error === "string" ? result.error : "", /xx/)
  }
})

test("the rag_* tools on a corpus never ingested fail with success:false (the chip is not green)", async () => {
  for (const call of [
    () => ragQueryTool.handler({ query: "incendie" }, ctx()),
    () => ragKeywordSearchTool.handler({ query: "incendie" }, ctx()),
    () => ragGetTextTool.handler({ ark: "ark:/12148/bpt6k2839841", entryId: 1 }, ctx()),
  ]) {
    const result = await call()
    assert.equal(toolCallErrored(false, JSON.stringify(result)), true, JSON.stringify(result))
  }
})

test("a mutating tool whose project vanished mid-turn returns a failure, never a throw", async () => {
  const gone: TurnScopedCtx = { ...ctx(), projectId: "00000000-0000-4000-8000-0000000000ff" }
  const result = await memoryWriteTool.handler({ section: "Sources", text: "Fait" }, gone)
  assert.ok(typeof result === "object" && result !== null)
  assert.equal("success" in result && result.success, false)
  assert.equal("error" in result && result.error, TOOL_PROJECT_GONE_ERROR)
})

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
