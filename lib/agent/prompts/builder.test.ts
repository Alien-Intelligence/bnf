// lib/agent/prompts/builder.test.ts
// The prompt-cache revision (found bug B5, owned by Track E): a cached system
// prompt is served only when it was rendered at the current PROMPT_REVISION.
// Before it, AppSession.systemPrompt was served forever once rendered, so a
// prompt-text change never reached existing sessions.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { User } from "@/lib/generated/prisma/client"
import { PROMPT_REVISION } from "@/lib/constants"
import { PromptBuilder } from "./builder"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import { createTestUser, createTestProject, createTestSession, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"

let user: User
let projectId: string
let sessionId: string

before(async () => {
  user = await createTestUser()
  projectId = (await createTestProject(user.id, "prompt-revision")).id
  sessionId = await createTestSession(projectId, SESSION_SCOPE.CORPUS)
})

after(async () => {
  await cleanupProject(projectId)
  await deleteTestUser(user.id)
})

const STALE = "PROMPT D'UNE RÉVISION ANTÉRIEURE"

test("a session whose cached prompt carries an older promptRevision is re-rendered", async () => {
  await prisma.appSession.update({
    where: { id: sessionId },
    data: { systemPrompt: STALE, promptLocale: "fr", promptRevision: "2026-09-01.older" },
  })
  const session = await prisma.appSession.findUniqueOrThrow({ where: { id: sessionId } })
  const prompt = await PromptBuilder.buildForSession(session, "fr")
  assert.notEqual(prompt, STALE)
  const after = await prisma.appSession.findUniqueOrThrow({ where: { id: sessionId } })
  assert.equal(after.promptRevision, PROMPT_REVISION, "the new render is stamped with the current revision")
  assert.equal(after.systemPrompt, prompt)
})

test("a cached prompt at the current revision and locale is served as is", async () => {
  await prisma.appSession.update({
    where: { id: sessionId },
    data: { systemPrompt: STALE, promptLocale: "fr", promptRevision: PROMPT_REVISION },
  })
  const session = await prisma.appSession.findUniqueOrThrow({ where: { id: sessionId } })
  assert.equal(await PromptBuilder.buildForSession(session, "fr"), STALE)
})

test("invalidateProject clears the prompt and its revision, and bumps the epoch", async () => {
  const before = await prisma.appSession.findUniqueOrThrow({ where: { id: sessionId } })
  await PromptBuilder.invalidateProject(projectId)
  const after = await prisma.appSession.findUniqueOrThrow({ where: { id: sessionId } })
  assert.equal(after.systemPrompt, null)
  assert.equal(after.promptRevision, null)
  assert.equal(after.promptEpoch, before.promptEpoch + 1)
})
