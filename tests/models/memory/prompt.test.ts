// tests/models/memory/prompt.test.ts
// Cross-scope memory and prompt-cache invalidation (Track E Phase 11, #10d).
//
// "Is project memory real?" — it was, but a research-scope fact ("Sources à
// risque") never reached the corpus agent: each prompt rendered its own
// scope's memory only. And a fact written mid-session never reached the cached
// prompts of the project's other sessions: memory_write invalidated through a
// `webpackIgnore` dynamic import whose `@/` alias never resolves natively, and
// the failure was swallowed. The memory dialog's write/delete paths never
// invalidated at all.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { MEMORY_CROSS_SCOPE_MAX_ITEMS } from "@/lib/constants"
import { PromptBuilder } from "@/lib/agent/prompts/builder"
import { memoryWriteTool } from "@/lib/agent/tools/memory"
import type { TurnScopedCtx } from "@/lib/agent/tools/registry-factory"
import { MEMORY_SCOPE } from "@/models/memory/schema"
import { MemoryService } from "@/models/memory/service"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import type { PolicyUser } from "@/models/users/schema"
import { createTestUser, createTestProject, createTestSession, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"

let user: User
let project: Project
let corpusSession: string
let researchSession: string

const CACHED = "PROMPT EN CACHE"

async function cacheBoth() {
  await prisma.appSession.updateMany({
    where: { id: { in: [corpusSession, researchSession] } },
    data: { systemPrompt: CACHED, promptLocale: "fr" },
  })
}

async function cached(id: string): Promise<string | null> {
  return (await prisma.appSession.findUniqueOrThrow({ where: { id }, select: { systemPrompt: true } })).systemPrompt
}

function researchCtx(): TurnScopedCtx {
  const policyUser: PolicyUser = { ...user, groupIds: [] }
  return {
    signal: new AbortController().signal,
    request: new Request("http://localhost/test"),
    db: prisma,
    user: policyUser,
    appSessionId: researchSession,
    projectId: project.id,
    corpusProjectId: project.id,
    corpusReachable: true,
    scope: "research",
  }
}

before(async () => {
  user = await createTestUser()
  project = await createTestProject(user.id, "memory-prompt")
  corpusSession = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  researchSession = await createTestSession(project.id, SESSION_SCOPE.RESEARCH)
})

after(async () => {
  await cleanupProject(project.id)
  await deleteTestUser(user.id)
})

test("memory_write clears every cached prompt of the project, both scopes, before it returns", async () => {
  await cacheBoth()
  await memoryWriteTool.handler(
    { section: "Sources à risque", text: "Le document bpt6k1 est mal daté (1937 au lieu de 1873)." },
    researchCtx(),
  )
  assert.equal(await cached(corpusSession), null, "the corpus session's prompt is cleared")
  assert.equal(await cached(researchSession), null, "the research session's prompt is cleared")
})

test("the corpus prompt shows the research memory as a read-only section", async () => {
  const session = await prisma.appSession.findUniqueOrThrow({ where: { id: corpusSession } })
  const prompt = await PromptBuilder.buildForSession(session, "fr")
  assert.match(prompt, /OTHER STEP \(READ-ONLY\)/)
  assert.match(prompt, /mal daté \(1937 au lieu de 1873\)/)
})

test("memory_write merges a near-duplicate through MemoryService.write", async () => {
  await memoryWriteTool.handler(
    { section: "Sources à risque", text: "Le document bpt6k1 est mal daté (1937 au lieu de 1874)." },
    researchCtx(),
  )
  const items = await prisma.memoryItem.count({
    where: { projectId: project.id, scope: "research", section: "Sources à risque" },
  })
  assert.equal(items, 1, "a one-character variant merges into the existing fact")
})

test("past the cap the other scope's memory says how many items are not shown", async () => {
  for (let i = 0; i < MEMORY_CROSS_SCOPE_MAX_ITEMS + 9; i++) {
    await prisma.memoryItem.create({
      data: { projectId: project.id, scope: "research", section: "Lot", text: `Fait de recherche numéro ${i}`, position: i },
    })
  }
  await prisma.appSession.update({ where: { id: corpusSession }, data: { systemPrompt: null } })
  const session = await prisma.appSession.findUniqueOrThrow({ where: { id: corpusSession } })
  const prompt = await PromptBuilder.buildForSession(session, "fr")
  const shown = (prompt.match(/Fait de recherche numéro/g) ?? []).length
  // Sections render in order ("Lot" before "Sources à risque"): the cap is
  // reached inside "Lot", so all 20 shown items are from the batch.
  assert.equal(shown, MEMORY_CROSS_SCOPE_MAX_ITEMS)
  assert.doesNotMatch(prompt, /mal daté/, "the item past the cap is not shown")
  assert.match(prompt, /\(\+10 éléments non affichés — memory_read scope="research"\)/)
})

test("a deletion through MemoryService.forget (the dialog path) clears the prompts", async () => {
  await cacheBoth()
  const item = await prisma.memoryItem.findFirstOrThrow({ where: { projectId: project.id, scope: "research" } })
  await MemoryService.forget(project.id, "research", item.id)
  assert.equal(await cached(corpusSession), null)
  assert.equal(await cached(researchSession), null)
})

test("the dialog's create, edit and reorder paths each clear every prompt", async () => {
  const created = await (async () => {
    await cacheBoth()
    const item = await MemoryService.createUserItem({
      projectId: project.id,
      scope: MEMORY_SCOPE.CORPUS,
      section: "Périmètre",
      text: "Presse quotidienne parisienne uniquement.",
    })
    assert.equal(await cached(corpusSession), null, "createUserItem clears the corpus prompt")
    assert.equal(await cached(researchSession), null, "createUserItem clears the research prompt")
    return item
  })()

  await cacheBoth()
  await MemoryService.update(created.id, { text: "Presse quotidienne parisienne et lyonnaise." })
  assert.equal(await cached(corpusSession), null, "update clears the corpus prompt")
  assert.equal(await cached(researchSession), null, "update clears the research prompt")

  await cacheBoth()
  await MemoryService.reorder(created.id, 3)
  assert.equal(await cached(corpusSession), null, "reorder clears the corpus prompt")
  assert.equal(await cached(researchSession), null, "reorder clears the research prompt")
})

test("forget of an item that is not there reports it and invalidates nothing", async () => {
  await cacheBoth()
  const deleted = await MemoryService.forget(project.id, MEMORY_SCOPE.RESEARCH, "00000000-0000-4000-8000-000000000000")
  assert.equal(deleted, false)
  assert.equal(await cached(corpusSession), CACHED, "no change, no invalidation")

  // The right id under the wrong scope is not a deletion either.
  const item = await prisma.memoryItem.findFirstOrThrow({
    where: { projectId: project.id, scope: MEMORY_SCOPE.CORPUS },
  })
  assert.equal(await MemoryService.forget(project.id, MEMORY_SCOPE.RESEARCH, item.id), false)
  assert.ok(await prisma.memoryItem.findUnique({ where: { id: item.id } }), "the item is still there")
})

test("a render that lost the race to a memory write is not cached; the new memory is", async () => {
  await PromptBuilder.invalidateProject(project.id)
  // The row as a turn read it BEFORE the write below (its epoch is now stale).
  const stale = await prisma.appSession.findUniqueOrThrow({ where: { id: corpusSession } })
  await MemoryService.write({
    projectId: project.id,
    // The corpus session's OWN scope: never capped, so the fact must show.
    scope: MEMORY_SCOPE.CORPUS,
    section: "Contraintes & filtres",
    text: "Le fonds Bxx est incomplet pour 1938.",
  })
  const prompt = await PromptBuilder.buildForSession(stale, "fr")
  const row = await prisma.appSession.findUniqueOrThrow({ where: { id: corpusSession } })
  assert.equal(row.promptEpoch, stale.promptEpoch + 1, "the write bumped the epoch")
  assert.equal(row.systemPrompt, prompt, "the prompt cached is the one rendered at the new epoch")
  assert.match(prompt, /fonds Bxx est incomplet/)
})
