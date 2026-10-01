// lib/agent/tools/rag.test.ts
// rag_get_text documents a 4 000-character default. The upstream MCP's own
// default is the opposite (char_limit 0 = the whole document), so the app must
// apply its documented default itself — otherwise "read the surrounding
// context" hands the agent an entire multi-hundred-folio volume.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import { ClusterRagClient } from "@/lib/cluster/rag"
import type { RagEntryContentRequest } from "@/lib/cluster/rag"
import { RAG_GET_TEXT_DEFAULT_CHAR_LIMIT } from "@/lib/constants"
import { ragGetTextTool } from "./rag"
import type { TurnScopedCtx } from "./registry-factory"
import {
  createTestUser,
  createTestProject,
  createTestSession,
  deleteTestUser,
} from "@/lib/testing/fixtures"
import { markHeadIngested } from "@/lib/testing/mark-ingested"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { SESSION_SCOPE } from "@/models/sessions/schema"

let userId: string
let projectId: string
let sessionId: string

function ctxFor(): TurnScopedCtx {
  return {
    signal: new AbortController().signal,
    request: new Request("http://localhost/test"),
    db: prisma,
    user: { id: userId } as TurnScopedCtx["user"],
    appSessionId: sessionId,
    projectId,
    corpusProjectId: projectId,
    corpusReachable: true,
    scope: "research",
  }
}

before(async () => {
  const user = await createTestUser()
  userId = user.id
  const project = await createTestProject(userId, "rag-get-text")
  projectId = project.id
  sessionId = await createTestSession(projectId, SESSION_SCOPE.RESEARCH)
  await markHeadIngested(projectId)
})

after(async () => {
  await cleanupProject(projectId)
  await deleteTestUser(userId)
})

test("rag_get_text forwards charLimit 4000 when the agent omits it", async () => {
  const original = ClusterRagClient.getEntryContent
  let captured: RagEntryContentRequest | null = null
  ClusterRagClient.getEntryContent = async (req) => {
    captured = req
    return {
      entryId: req.entryId,
      text: "",
      charOffset: req.charOffset ?? 0,
      charLimit: req.charLimit ?? 0,
      totalLength: 0,
      hasMore: false,
      nextOffset: 0,
    }
  }
  try {
    await ragGetTextTool.handler({ entryId: 3 }, ctxFor())
  } finally {
    ClusterRagClient.getEntryContent = original
  }
  assert.ok(captured, "the facade was called")
  assert.equal(RAG_GET_TEXT_DEFAULT_CHAR_LIMIT, 4_000)
  assert.equal((captured as RagEntryContentRequest).charLimit, RAG_GET_TEXT_DEFAULT_CHAR_LIMIT)
  assert.equal((captured as RagEntryContentRequest).entryId, 3)
})

test("rag_get_text keeps an explicit charLimit, including 0 (the rest of the document)", async () => {
  const original = ClusterRagClient.getEntryContent
  const seen: number[] = []
  ClusterRagClient.getEntryContent = async (req) => {
    seen.push(req.charLimit ?? -1)
    return {
      entryId: req.entryId,
      text: "",
      charOffset: 0,
      charLimit: req.charLimit ?? 0,
      totalLength: 0,
      hasMore: false,
      nextOffset: 0,
    }
  }
  try {
    await ragGetTextTool.handler({ entryId: 3, charLimit: 0 }, ctxFor())
    await ragGetTextTool.handler({ entryId: 3, charLimit: 1_200 }, ctxFor())
  } finally {
    ClusterRagClient.getEntryContent = original
  }
  assert.deepEqual(seen, [0, 1_200])
})
