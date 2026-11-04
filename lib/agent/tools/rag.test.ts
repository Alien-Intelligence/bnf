// lib/agent/tools/rag.test.ts
// The rag tools' read path. rag_get_text documents a 4 000-character default;
// the upstream MCP's own default is the opposite (char_limit 0 = the whole
// document), so the handler applies it — once, here — or "read the
// surrounding context" hands the agent an entire multi-hundred-folio volume.
// Every tool must address the CORPUS project and forward the turn's signal.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import { ClusterRagClient, RAG_LOOKUP_STATUS } from "@/lib/cluster/rag"
import { entryIdSchema } from "@/lib/cluster/composite-ids"
import type { RagEntryContentRequest } from "@/lib/cluster/rag"
import { RAG_DEFAULT_K, RAG_GET_TEXT_DEFAULT_CHAR_LIMIT, RAG_KEYWORD_DEFAULT_LIMIT } from "@/lib/constants"
import { entryNotInCorpusError, entryReindexingError, ragGetTextTool, ragKeywordSearchTool, ragQueryTool } from "./rag"
import { toolCallErrored } from "@/lib/tools/display"
import type { TurnScopedCtx } from "./registry-factory"
import {
  createTestUser,
  createTestProject,
  createTestSession,
  deleteTestUser,
} from "@/lib/testing/fixtures"
import { markHeadIngested } from "@/lib/testing/mark-ingested"
import { seedCorpusDocuments } from "@/lib/testing/seed-corpus"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { SESSION_SCOPE } from "@/models/sessions/schema"

const ENTRY = entryIdSchema.parse("113:6363:3")
const OTHER_ENTRY = entryIdSchema.parse("113:6363:99")
const LIVE_ENTRY = entryIdSchema.parse("113:6363:12")

let user: TurnScopedCtx["user"]
let userId: string
let projectId: string
let derivedId: string
let sessionId: string

/**
 * A derived-shaped context: the turn runs in workspace `derivedId`, but its
 * corpus is `projectId`'s. Every rag tool must address the CORPUS project; a
 * regression to `ctx.projectId` would read a dataset the workspace has none of.
 */
function ctxFor(signal: AbortSignal = new AbortController().signal): TurnScopedCtx {
  return {
    signal,
    request: new Request("http://localhost/test"),
    db: prisma,
    user,
    appSessionId: sessionId,
    projectId: derivedId,
    corpusProjectId: projectId,
    corpusReachable: true,
    scope: "research",
  }
}

before(async () => {
  user = { ...(await createTestUser()), groupIds: [] }
  userId = user.id
  const project = await createTestProject(userId, "rag-get-text")
  projectId = project.id
  const derived = await createTestProject(userId, "rag-get-text-workspace")
  derivedId = derived.id
  sessionId = await createTestSession(derivedId, SESSION_SCOPE.RESEARCH)
  await markHeadIngested(projectId)
  // rag_get_text reads only an indexed Document of the corpus (plan D8): the
  // ARK these tests read is one, as every search result's ARK is.
  await seedCorpusDocuments(projectId, [{ ark: ARK, title: "Le Figaro" }], `user:${userId}`)
  await prisma.document.updateMany({ where: { projectId, ark: ARK }, data: { indexedAt: new Date() } })
})

after(async () => {
  await cleanupProject(derivedId)
  await cleanupProject(projectId)
  await deleteTestUser(userId)
})

const ARK = "ark:/12148/bpt6k2839841"

/** Replace the facade's getEntryContent for one call, capturing the request. */
async function captureGetText(
  input: Omit<Parameters<typeof ragGetTextTool.handler>[0], "ark">,
  signal?: AbortSignal,
) {
  const original = ClusterRagClient.getEntryContent
  const seen: RagEntryContentRequest[] = []
  ClusterRagClient.getEntryContent = async (req) => {
    seen.push(req)
    return {
      status: RAG_LOOKUP_STATUS.FOUND,
      content: {
        entryId: req.entryId,
        text: "",
        charOffset: req.charOffset,
        charLimit: req.charLimit,
        totalLength: 0,
        hasMore: false,
        nextOffset: 0,
      },
    }
  }
  try {
    await ragGetTextTool.handler({ ark: ARK, ...input }, ctxFor(signal))
  } finally {
    ClusterRagClient.getEntryContent = original
  }
  const [req] = seen
  assert.ok(req, "the facade was called")
  return req
}

test("rag_get_text forwards charLimit 4000 and offset 0 when the agent omits them", async () => {
  const req = await captureGetText({ entryId: ENTRY })
  assert.equal(RAG_GET_TEXT_DEFAULT_CHAR_LIMIT, 4_000)
  assert.equal(req.charLimit, RAG_GET_TEXT_DEFAULT_CHAR_LIMIT)
  assert.equal(req.charOffset, 0)
  assert.equal(req.entryId, ENTRY)
})

test("rag_get_text keeps an explicit charLimit, including 0 (the rest of the document)", async () => {
  assert.equal((await captureGetText({ entryId: ENTRY, charLimit: 0 })).charLimit, 0)
  assert.equal((await captureGetText({ entryId: ENTRY, charLimit: 1_200 })).charLimit, 1_200)
})

test("rag_get_text reads the CORPUS project with the turn's signal", async () => {
  const controller = new AbortController()
  const req = await captureGetText({ entryId: ENTRY }, controller.signal)
  assert.equal(req.projectId, projectId, "corpus project, not the workspace")
  assert.equal(req.ark, ARK, "the ARK the entry must belong to is passed on")
  assert.notEqual(req.projectId, derivedId)
  assert.equal(req.signal, controller.signal)
})

test("rag_query and rag_keyword_search read the CORPUS project with the turn's signal", async () => {
  const controller = new AbortController()
  const originalQuery = ClusterRagClient.query
  const originalKeyword = ClusterRagClient.keywordSearch
  const seen: Array<{ projectId: string; signal: AbortSignal }> = []
  ClusterRagClient.query = async (req) => {
    seen.push(req)
    return { passages: [], total: 0, modelVersion: "test" }
  }
  ClusterRagClient.keywordSearch = async (req) => {
    seen.push(req)
    return { hits: [], total: 0 }
  }
  try {
    await ragQueryTool.handler({ query: "incendie" }, ctxFor(controller.signal))
    await ragKeywordSearchTool.handler({ query: "incendie" }, ctxFor(controller.signal))
  } finally {
    ClusterRagClient.query = originalQuery
    ClusterRagClient.keywordSearch = originalKeyword
  }
  assert.equal(seen.length, 2)
  for (const req of seen) {
    assert.equal(req.projectId, projectId)
    assert.equal(req.signal, controller.signal)
  }
})

test("rag_query does not pass filters it cannot apply, and reports them as ignored", async () => {
  const original = ClusterRagClient.query
  const seen: Array<Record<string, unknown>> = []
  ClusterRagClient.query = async (req) => {
    seen.push({ ...req })
    return { passages: [], total: 0, modelVersion: "test" }
  }
  let withFilters: unknown
  let without: unknown
  try {
    withFilters = await ragQueryTool.handler({ query: "incendie", filters: { yearFrom: 1930, lang: ["fre"] } }, ctxFor())
    without = await ragQueryTool.handler({ query: "incendie" }, ctxFor())
  } finally {
    ClusterRagClient.query = original
  }
  assert.ok(seen.every((req) => !("filters" in req)), "the facade request carries no filters")
  assert.deepEqual(withFilters, { passages: [], total: 0, modelVersion: "test", ignoredFilters: ["yearFrom", "lang"] })
  assert.deepEqual(without, { passages: [], total: 0, modelVersion: "test" })
})

test("rag_query and rag_keyword_search resolve their defaults once, in the handler", async () => {
  const originalQuery = ClusterRagClient.query
  const originalKeyword = ClusterRagClient.keywordSearch
  const ks: number[] = []
  const limits: number[] = []
  ClusterRagClient.query = async (req) => {
    ks.push(req.k)
    return { passages: [], total: 0, modelVersion: "test" }
  }
  ClusterRagClient.keywordSearch = async (req) => {
    limits.push(req.limit)
    return { hits: [], total: 0 }
  }
  try {
    await ragQueryTool.handler({ query: "incendie" }, ctxFor())
    await ragQueryTool.handler({ query: "incendie", k: 7 }, ctxFor())
    await ragKeywordSearchTool.handler({ query: "incendie" }, ctxFor())
    await ragKeywordSearchTool.handler({ query: "incendie", limit: 3 }, ctxFor())
  } finally {
    ClusterRagClient.query = originalQuery
    ClusterRagClient.keywordSearch = originalKeyword
  }
  assert.deepEqual(ks, [RAG_DEFAULT_K, 7])
  assert.deepEqual(limits, [RAG_KEYWORD_DEFAULT_LIMIT, 3])
})

test("a rag tool refusal is recorded as a failed call, not an ok one", async () => {
  // A derived-shaped ctx whose corpus is NOT ingested: a fresh project.
  const bare = await createTestProject(userId, "rag-refusal")
  try {
    const out = await ragQueryTool.handler({ query: "incendie" }, { ...ctxFor(), corpusProjectId: bare.id })
    assert.equal(toolCallErrored(false, out), true)
  } finally {
    await cleanupProject(bare.id)
  }
})

test("rag_get_text refuses an entry id the ARK lookup does not vouch for in this corpus", async () => {
  const original = ClusterRagClient.getEntryContent
  ClusterRagClient.getEntryContent = async () => ({
    status: RAG_LOOKUP_STATUS.ENTRY_NOT_IN_CORPUS,
    liveEntryId: LIVE_ENTRY,
  })
  let out: unknown
  try {
    out = await ragGetTextTool.handler({ ark: ARK, entryId: OTHER_ENTRY }, ctxFor())
  } finally {
    ClusterRagClient.getEntryContent = original
  }
  assert.deepEqual(out, { success: false, error: entryNotInCorpusError(ARK, OTHER_ENTRY, LIVE_ENTRY) })
  assert.match(entryNotInCorpusError(ARK, OTHER_ENTRY, LIVE_ENTRY), /entrée actuelle est "113:6363:12"/, "the refusal names the live id")
  assert.equal(toolCallErrored(false, out), true)
})

test("rag_get_text's schema requires an ARK and a composite entry id", () => {
  const schema = ragGetTextTool.inputSchema
  assert.equal(schema.safeParse({ entryId: ENTRY }).success, false, "ark is required")
  assert.equal(schema.safeParse({ ark: ARK, entryId: ENTRY }).success, true)
  // The server refuses integer ids: the tool refuses them before the call.
  assert.equal(schema.safeParse({ ark: ARK, entryId: 3 }).success, false, "a bare number is the old contract")
  assert.equal(schema.safeParse({ ark: ARK, entryId: "3" }).success, false, "so is its string form")
  assert.equal(schema.safeParse({ ark: ARK, entryId: "113:6363" }).success, false, "a dataset id is not an entry id")
  assert.equal(schema.safeParse({ ark: ARK, entryId: "113:6363:abc" }).success, false)
})

test("rag_get_text tells the agent a document is being re-indexed, and to retry later or use another passage", async () => {
  const original = ClusterRagClient.getEntryContent
  ClusterRagClient.getEntryContent = async () => ({ status: RAG_LOOKUP_STATUS.ENTRY_REINDEXING })
  let out: unknown
  try {
    out = await ragGetTextTool.handler({ ark: ARK, entryId: ENTRY }, ctxFor())
  } finally {
    ClusterRagClient.getEntryContent = original
  }
  assert.deepEqual(out, { success: false, error: entryReindexingError(ARK) })
  assert.match(entryReindexingError(ARK), /en cours de réindexation[\s\S]*Réessaie[\s\S]*plus tard[\s\S]*un autre passage/)
  assert.equal(toolCallErrored(false, out), true)
})

test("rag_keyword_search's lang filter tells the model the stored value, the BnF's French label, not an ISO code", () => {
  const filters = ragKeywordSearchTool.inputSchema.shape.filters.unwrap().shape
  const description = filters.lang.description ?? ""
  assert.match(description, /Français/)
  assert.match(description, /NOT an ISO code/)
  assert.doesNotMatch(description, /e\.g\. "fr"\)/)
})
