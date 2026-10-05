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
import { PROMPT_CACHE_MAX_RENDERS, PromptBuilder } from "./builder"
import { SessionQueries } from "@/models/sessions/queries"
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

test("an invalidation clears the prompt and its revision, and bumps the epoch", async () => {
  const before = await prisma.appSession.findUniqueOrThrow({ where: { id: sessionId } })
  await SessionQueries.invalidatePrompts({ projectId })
  const after = await prisma.appSession.findUniqueOrThrow({ where: { id: sessionId } })
  assert.equal(after.systemPrompt, null)
  assert.equal(after.promptRevision, null)
  assert.equal(after.promptEpoch, before.promptEpoch + 1)
})

test("a change landing BETWEEN render and save is never cached: the prompt is re-rendered", async () => {
  await SessionQueries.invalidatePrompts({ projectId })
  const session = await prisma.appSession.findUniqueOrThrow({ where: { id: sessionId } })
  let renders = 0
  const prompt = await PromptBuilder.buildForSession(session, "fr", async (s, l) => {
    renders += 1
    const rendered = `RENDER ${renders} ` + (await PromptBuilder.renderForTests(s, l))
    // The first render races a change that lands after it read its inputs.
    if (renders === 1) await SessionQueries.invalidatePrompts({ projectId })
    return rendered
  })
  assert.equal(renders, 2, "the stale render lost the compare-and-set and was redone")
  assert.match(prompt, /^RENDER 2 /)
  const row = await prisma.appSession.findUniqueOrThrow({ where: { id: sessionId } })
  assert.equal(row.systemPrompt, prompt, "only the fresh render is cached")
})

test("a change landing on every render stops at the ceiling and caches nothing", async () => {
  await SessionQueries.invalidatePrompts({ projectId })
  const session = await prisma.appSession.findUniqueOrThrow({ where: { id: sessionId } })
  let renders = 0
  const prompt = await PromptBuilder.buildForSession(session, "fr", async () => {
    renders += 1
    await SessionQueries.invalidatePrompts({ projectId })
    return `RENDER ${renders}`
  })
  assert.equal(renders, PROMPT_CACHE_MAX_RENDERS)
  assert.equal(prompt, `RENDER ${PROMPT_CACHE_MAX_RENDERS}`, "the last render is served")
  const row = await prisma.appSession.findUniqueOrThrow({ where: { id: sessionId } })
  assert.equal(row.systemPrompt, null, "but never cached")
})
