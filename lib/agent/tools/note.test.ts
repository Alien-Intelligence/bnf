// lib/agent/tools/note.test.ts
// The note ingestion guard (plan §3.5 layer 2, design item 4). A note must rest
// on the ingested corpus, never on general knowledge before any retrieval
// exists. This is the STRUCTURAL fix for "mis-informed notes" — it must hold
// even if boundary gating is bypassed, so we exercise the handlers directly
// rather than through the agent loop.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db"
import { noteCreateTool, noteUpdateTool, noteAppendTool } from "./note"
import { NOTE_NOT_INGESTED_ERROR } from "./ingestion-guard"
import type { TurnScopedCtx } from "./registry-factory"
import {
  createTestUser,
  createTestProject,
  createTestSession,
  deleteTestUser,
} from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { SESSION_SCOPE } from "@/models/sessions/schema"

let userId: string
let projectId: string
let sessionId: string

function ctxFor(): TurnScopedCtx {
  return {
    signal: new AbortController().signal,
    db: prisma,
    user: { id: userId } as TurnScopedCtx["user"],
    appSessionId: sessionId,
    projectId,
    scope: "research",
  } as unknown as TurnScopedCtx
}

before(async () => {
  const user = await createTestUser()
  userId = user.id
  const project = await createTestProject(userId, "note-guard")
  projectId = project.id
  sessionId = await createTestSession(projectId, SESSION_SCOPE.RESEARCH)
})

after(async () => {
  await cleanupProject(projectId)
  await deleteTestUser(userId)
})

// --- Nothing ingested → every write tool refuses --------------------------

test("note_create is refused when ingestedVersionId is null", async () => {
  const before = await prisma.note.count({ where: { projectId } })
  const result = (await noteCreateTool.handler(
    { title: "Note prématurée", body_md: "Ceci ne doit pas être écrit." },
    ctxFor(),
  )) as Record<string, unknown>
  assert.equal(result["error"], NOTE_NOT_INGESTED_ERROR)
  assert.equal(await prisma.note.count({ where: { projectId } }), before, "no note row created")
})

test("note_update is refused when ingestedVersionId is null (guard before lookup)", async () => {
  // A random UUID is fine: the guard fires before NoteService.update runs, so
  // the note need not exist. If the guard were removed, this would 500 on a
  // missing note instead — still a refusal, but not the structural one we want.
  const result = (await noteUpdateTool.handler(
    { id: randomUUID(), title: "x", body_md: "y" },
    ctxFor(),
  )) as Record<string, unknown>
  assert.equal(result["error"], NOTE_NOT_INGESTED_ERROR)
})

test("note_append is refused when ingestedVersionId is null (guard before lookup)", async () => {
  const result = (await noteAppendTool.handler(
    { id: randomUUID(), body_md: "z" },
    ctxFor(),
  )) as Record<string, unknown>
  assert.equal(result["error"], NOTE_NOT_INGESTED_ERROR)
})

// --- After a committed ingest → note_create succeeds -----------------------

test("note_create succeeds once the project has an ingested version", async () => {
  // Point ingestedVersionId at the project's head version — the guard only
  // checks non-null, so this is the minimal "something was ingested" state.
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { headVersionId: true },
  })
  assert.ok(project.headVersionId, "fixture project has a head version")
  await prisma.project.update({
    where: { id: projectId },
    data: { ingestedVersionId: project.headVersionId },
  })

  const before = await prisma.note.count({ where: { projectId } })
  const result = (await noteCreateTool.handler(
    { title: "Note fondée sur le corpus", body_md: "## Résumé\n\nUn contenu valide." },
    ctxFor(),
  )) as Record<string, unknown>

  assert.equal(result["error"], undefined, "no guard error after ingestion")
  assert.ok(typeof result["note_id"] === "string", "returns a note_id")
  assert.equal(
    await prisma.note.count({ where: { projectId } }),
    before + 1,
    "exactly one note row created",
  )
})
