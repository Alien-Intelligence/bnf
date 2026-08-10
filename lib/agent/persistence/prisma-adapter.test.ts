// lib/agent/persistence/prisma-adapter.test.ts
// The compaction checkpoint round-trip (agent-context-survival Slice 2). The SDK
// compaction stage is unit-tested in chat-sdk; here we lock BnF's half of the
// contract: the Prisma adapter persists a CompactionCheckpoint on AppSession and
// reads it back, mapping the SDK's `coveredMessageCount` ↔ the
// `compactedMessageCount` column. Deterministic, real dev Postgres, no LLM.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import { createPrismaChatAdapter } from "./prisma-adapter"
import {
  createTestUser,
  createTestProject,
  createTestSession,
  deleteTestUser,
} from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { SESSION_SCOPE } from "@/models/sessions/schema"

const adapter = createPrismaChatAdapter()
let userId: string
let projectId: string
let sessionId: string

before(async () => {
  const user = await createTestUser()
  userId = user.id
  const project = await createTestProject(userId, "checkpoint")
  projectId = project.id
  sessionId = await createTestSession(projectId, SESSION_SCOPE.CORPUS)
})

after(async () => {
  await cleanupProject(projectId)
  await deleteTestUser(userId)
})

test("loadCheckpoint returns null for a session with no synopsis", async () => {
  assert.equal(await adapter.loadCheckpoint!(sessionId), null)
})

test("saveCheckpoint persists synopsis + coveredMessageCount, loadCheckpoint reads it back", async () => {
  await adapter.saveCheckpoint!(sessionId, { synopsis: "RÉSUMÉ ark:/12148/x", coveredMessageCount: 4 })
  assert.deepEqual(await adapter.loadCheckpoint!(sessionId), {
    synopsis: "RÉSUMÉ ark:/12148/x",
    coveredMessageCount: 4,
  })
})

test("saveCheckpoint upserts — a later boundary advance overwrites the prior one", async () => {
  await adapter.saveCheckpoint!(sessionId, { synopsis: "S2", coveredMessageCount: 12 })
  assert.deepEqual(await adapter.loadCheckpoint!(sessionId), {
    synopsis: "S2",
    coveredMessageCount: 12,
  })
})
