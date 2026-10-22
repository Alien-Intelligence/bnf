// lib/agent/tools/corpus-search-found.test.ts
// `found` is the number of hits the BnF returned, counted BEFORE identifier
// mapping: a hit whose identifier is not a document ARK is dropped before
// registration, and it must be explained like a registration skip — never
// vanish from the counts (playbook review: `found` was post-mapping).
// No BnF egress: the MCP transport is a stubbed fetch, the MCP env points at
// a reserved `.invalid` host and the limiter is built from fixed test rates —
// nothing here depends on a developer's .env.local.
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

const MCP_ENV_KEYS = ["BNF_MCP_URL", "BNF_MCP_TOKEN"] as const
const savedMcpEnv: Record<string, string | undefined> = {}

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
  // corpus_search reads the MCP env lazily (requireMcpEnv). Set here, after
  // lib/env.ts ran its import-time BNF_MCP_RATES boot check, it needs no rate
  // env: the limiter is replaced with fixed test rates below.
  for (const k of MCP_ENV_KEYS) savedMcpEnv[k] = process.env[k]
  process.env.BNF_MCP_URL = "https://bnf.mcp.invalid/mcp"
  process.env.BNF_MCP_TOKEN = "test-token"
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
  for (const k of MCP_ENV_KEYS) {
    const v = savedMcpEnv[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
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
  const realWarn = console.warn
  const warned: unknown[] = []
  console.warn = (message: string, detail: unknown) => {
    if (message === "[corpus_search] hit ARK refused") warned.push(detail)
  }
  let result: Awaited<ReturnType<typeof corpusSearchTool.handler>>
  try {
    result = await corpusSearchTool.handler({ source: "gallica", doc_type: "fascicule", query: "incendie" }, ctx)
  } finally {
    console.warn = realWarn
  }
  const shown = JSON.stringify(result)
  assert.ok(typeof result === "object" && result !== null && "found" in result, shown)
  assert.equal(result.found, 3, "every hit the BnF returned")
  assert.equal("added" in result && result.added, 2)
  assert.equal("skipped_not_a_document" in result && result.skipped_not_a_document, 1)
  assert.equal("ark_refused" in result && result.ark_refused, 1, "the refused ARK is counted on its own")
  assert.deepEqual(warned, [{ source: "gallica", rawArk: "pas un identifiant !" }], "and logged with its raw value")
  assert.match("explanation" in result && typeof result.explanation === "string" ? result.explanation : "", /pas un document/)
})
