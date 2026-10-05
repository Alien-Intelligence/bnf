// lib/agent/tools/corpus-search-found.test.ts
// `found` is the number of hits the BnF returned, counted BEFORE identifier
// mapping: a hit whose identifier is not a document ARK is dropped before
// registration, and it must be explained like a registration skip — never
// vanish from the counts (playbook review: `found` was post-mapping).
// No BnF egress: the MCP transport is a stubbed fetch.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { __resetBnfRateLimiterForTests } from "@/lib/mcp/rate-limit"
import { createTestUser, createTestProject, createTestSession, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import { corpusSearchTool } from "./buffer"
import type { TurnScopedCtx } from "./registry-factory"

let user: User
let project: Project
let session: string
const realFetch = globalThis.fetch

const hit = (ark: string, title: string) => ({
  ark,
  title,
  creator: null,
  date: "1937",
  doc_type: "fascicule",
  language: "fre",
  description: null,
  subject: null,
  publisher: null,
  gallica_url: null,
})

before(async () => {
  user = await createTestUser()
  project = await createTestProject(user.id, "search-found")
  session = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  __resetBnfRateLimiterForTests({
    globalRpm: 475,
    catalogueRpm: 47,
    gallicaSruRpm: 95,
    iiifRpm: 285,
    issuesRpm: 47,
    grapheRpm: 47,
    maxWaitMs: 1_000,
  })
  globalThis.fetch = async () => {
    const payload = {
      pagination: { total: 3, count: 3, has_more: false, start_record: 1 },
      executed_cql: 'dc.type all "fascicule"',
      data: {
        results: [
          hit("bpt6k9700001", "Numéro un"),
          hit("bpt6k9700002", "Numéro deux"),
          hit("pas un identifiant !", "Inexploitable"),
        ],
      },
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: "1", result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
})

after(async () => {
  globalThis.fetch = realFetch
  await cleanupProject(project.id)
  await deleteTestUser(user.id)
})

test("found counts every hit; the unaddressable one is explained, not lost", async () => {
  const ctx: TurnScopedCtx = {
    signal: new AbortController().signal,
    request: new Request("http://localhost/test"),
    db: prisma,
    user: { ...user, groupIds: [] },
    appSessionId: session,
    projectId: project.id,
    corpusProjectId: project.id,
    corpusReachable: true,
    scope: SESSION_SCOPE.CORPUS,
  }
  const result = await corpusSearchTool.handler({ source: "gallica", doc_type: "fascicule", query: "incendie" }, ctx)
  const shown = JSON.stringify(result)
  assert.ok(typeof result === "object" && result !== null && "found" in result, shown)
  assert.equal(result.found, 3, "every hit the BnF returned")
  assert.equal("added" in result && result.added, 2)
  assert.equal("skipped_not_a_document" in result && result.skipped_not_a_document, 1)
  assert.match("explanation" in result && typeof result.explanation === "string" ? result.explanation : "", /pas un document/)
})
