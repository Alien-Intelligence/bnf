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
import {
  noteAppendTool,
  noteCreateTool,
  noteGetTool,
  noteListTool,
  noteResult,
  noteUpdateTool,
  type NoteOcrOutcome,
} from "./note"
import {
  NOTE_LOW_OCR_NOTICE,
  NOTE_OCR_CHECK_FAILED_NOTICE,
  NOTE_OCR_UNKNOWN_NOTICE,
} from "./constants"
import { OCR_SOURCE, OCR_SYNC_STATUS } from "@/models/documents/schema"
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
    request: new Request("http://localhost/test"),
    db: prisma,
    user: { id: userId } as TurnScopedCtx["user"],
    appSessionId: sessionId,
    projectId,
    // This project owns its corpus, so the corpus id is its own and the grant
    // question does not arise. Spelled out rather than cast away: a new field
    // on TurnScopedCtx must be a decision here, not a silent undefined.
    corpusProjectId: projectId,
    corpusReachable: true,
    scope: "research",
  }
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

// --- OCR quality in the note results (feedback 2026-09-29 #7) -------------

const WRITTEN = { id: "00000000-0000-4000-8000-000000000001", title: "Note", citationCount: 2 }
const NOTHING: NoteOcrOutcome = { kind: "checked", report: { low: [], unknown: [] } }

test("noteResult with nothing to say about OCR is byte-identical to before", () => {
  assert.equal(
    JSON.stringify(noteResult(WRITTEN, [], NOTHING)),
    JSON.stringify({ note_id: WRITTEN.id, title: WRITTEN.title, citation_count: 2 }),
  )
})

test("noteResult reports low and unknown citations with their notices", () => {
  const low = [{ ark: "ark:/12148/bpt6k4625753w", folio: 2, ocr_quality: 0.661 }]
  const unknown = [{ ark: "ark:/12148/bpt6k4625753w", folio: 5, ocr_state: "not_synced" as const }]
  assert.deepEqual(noteResult(WRITTEN, [], { kind: "checked", report: { low, unknown } }), {
    note_id: WRITTEN.id,
    title: WRITTEN.title,
    citation_count: 2,
    low_ocr_citations: { citations: low, message: NOTE_LOW_OCR_NOTICE },
    ocr_unknown_citations: { citations: unknown, message: NOTE_OCR_UNKNOWN_NOTICE },
  })
})

test("noteResult after a failed OCR check still reports the write, never an error", () => {
  const result = noteResult(WRITTEN, [], { kind: "check_failed" })
  assert.equal(result.note_id, WRITTEN.id)
  assert.deepEqual(result.ocr_check, { status: "failed", message: NOTE_OCR_CHECK_FAILED_NOTICE })
})

// --- Handlers against stored DocumentFolio rows ----------------------------

const OCR_ARK = `ark:/12148/zznoteocr${randomUUID().replaceAll("-", "").slice(0, 8)}`

async function seedOcrDocument(): Promise<void> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { headVersionId: true },
  })
  assert.ok(project.headVersionId, "fixture project has a head version")
  await prisma.document.create({ data: { projectId, ark: OCR_ARK, indexedAt: new Date() } })
  await prisma.corpusMembership.create({
    data: { versionId: project.headVersionId, ark: OCR_ARK, projectId },
  })
  await prisma.documentOcr.create({
    data: {
      ark: OCR_ARK,
      status: OCR_SYNC_STATUS.AVAILABLE,
      ocrRate: 0.7821,
      checkedAt: new Date(),
      syncedAt: new Date(),
      folios: {
        create: [
          { folio: 1, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.932, wordCount: 5106 },
          { folio: 2, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.661, wordCount: 4016 },
        ],
      },
    },
  })
}

after(async () => {
  await prisma.documentOcr.deleteMany({ where: { ark: OCR_ARK } })
})

test("note_create reports the stored low folio and the unrecorded one", async () => {
  await seedOcrDocument()
  const result = (await noteCreateTool.handler(
    {
      title: "Note OCR",
      body_md: `[[${OCR_ARK}|Source|2]] [[${OCR_ARK}|Source|1]] [[${OCR_ARK}|Source|7]]`,
    },
    ctxFor(),
  )) as Record<string, unknown>
  assert.deepEqual(result["low_ocr_citations"], {
    citations: [{ ark: OCR_ARK, folio: 2, ocr_quality: 0.661 }],
    message: NOTE_LOW_OCR_NOTICE,
  })
  assert.deepEqual(result["ocr_unknown_citations"], {
    citations: [{ ark: OCR_ARK, folio: 7, ocr_state: "not_recorded" }],
    message: NOTE_OCR_UNKNOWN_NOTICE,
  })
})

test("note_get and note_list carry the same OCR state", async () => {
  const note = await prisma.note.findFirstOrThrow({ where: { projectId, title: "Note OCR" } })
  const got = (await noteGetTool.handler({ id: note.id }, ctxFor())) as Record<string, unknown>
  assert.deepEqual(got["low_ocr_citations"], {
    citations: [{ ark: OCR_ARK, folio: 2, ocr_quality: 0.661 }],
    message: NOTE_LOW_OCR_NOTICE,
  })
  const listed = (await noteListTool.handler({}, ctxFor())) as {
    notes: Array<{ id: string; low_ocr_citation_count: number; ocr_unknown_citation_count: number }>
  }
  const row = listed.notes.find((n) => n.id === note.id)
  assert.ok(row, "the note is listed")
  assert.equal(row.low_ocr_citation_count, 1)
  assert.equal(row.ocr_unknown_citation_count, 1)
})

test("a committed note_create whose OCR check fails is still a success, never isError", async () => {
  const aborted = new AbortController()
  aborted.abort()
  const before = await prisma.note.count({ where: { projectId } })
  const result = (await noteCreateTool.handler(
    { title: "Note OCR check failed", body_md: `[[${OCR_ARK}|Source|2]]` },
    { ...ctxFor(), signal: aborted.signal },
  )) as Record<string, unknown>
  assert.equal(await prisma.note.count({ where: { projectId } }), before + 1, "the note is written")
  assert.ok(typeof result["note_id"] === "string")
  assert.deepEqual(result["ocr_check"], { status: "failed", message: NOTE_OCR_CHECK_FAILED_NOTICE })
})
