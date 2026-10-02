// lib/agent/tools/note.test.ts
// The note ingestion guard (plan §3.5 layer 2, design item 4). A note must rest
// on the ingested corpus, never on general knowledge before any retrieval
// exists. This is the STRUCTURAL fix for "mis-informed notes" — it must hold
// even if boundary gating is bypassed, so we exercise the handlers directly
// rather than through the agent loop.
import "server-only"

import { test, before, after, describe } from "node:test"
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
import { ClusterRagClient } from "@/lib/cluster/rag"
import { seedCorpusDocuments } from "@/lib/testing/seed-corpus"
import { markHeadIngested } from "@/lib/testing/mark-ingested"
import { QUOTE_WARNING_REASON } from "@/models/notes/schema"
import { ProjectService } from "@/models/projects/service"

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

// --- Quote guard: every agent note write checks its quotes ------------------
//
// The guard runs against the FAKE cluster (CLUSTER_MODE=fake, set below for
// this process), whose entry text is assembled from lib/cluster/rag-fixtures.ts
// in the same folio-headed format worker-v2 writes. Le Figaro, 6 mai 1889:
// folio 1 ends « … se pressait aux abords du Champ de Mars. », folio 2 holds
// « C'est la fête du travail et de la paix … ».


const FIGARO = "ark:/12148/bpt6k2839841"
const FIGARO_CITE = (folio: number) => `[[${FIGARO}|Le Figaro, 6 mai 1889|${folio}]]`
const STITCHED =
  `« Dès l'aube, une foule considérable se pressait aux abords du Champ de Mars […] ` +
  `C'est la fête du travail et de la paix » ${FIGARO_CITE(1)}`
const EXACT = `« une foule considérable se pressait aux abords du Champ de Mars » ${FIGARO_CITE(1)}`

type Warning = { reason: string; citation: { ark: string; folio: number } | null }
function warningsOf(result: Record<string, unknown>): Warning[] {
  return (result["quote_warnings"] as Warning[] | undefined) ?? []
}
function checkOf(result: Record<string, unknown>): { status: string; checked: number } | undefined {
  return result["quote_check"] as { status: string; checked: number } | undefined
}

// A suite of its own: its `before` runs when the suite starts, AFTER the
// not-ingested tests above have had the project in its un-ingested state.
describe("quote guard", () => {
  const clusterModeBefore = process.env.CLUSTER_MODE
  before(async () => {
    process.env.CLUSTER_MODE = "fake"
    await seedCorpusDocuments(projectId, [{ ark: FIGARO, title: "Le Figaro" }], `user:${userId}`)
    await markHeadIngested(projectId)
  })

  after(() => {
    if (clusterModeBefore === undefined) delete process.env.CLUSTER_MODE
    else process.env.CLUSTER_MODE = clusterModeBefore
  })

  test("note_create with a quote stitched across two folios returns quote_warnings[elision_across_folios]", async () => {
    const result = (await noteCreateTool.handler(
      { title: "Inauguration", body_md: `## Foule\n\n${STITCHED}` },
      ctxFor(),
    )) as Record<string, unknown>
    assert.ok(typeof result["note_id"] === "string", "the note is written regardless")
    assert.deepEqual(checkOf(result), { status: "complete", checked: 1 })
    assert.deepEqual(
      warningsOf(result).map((w) => [w.reason, w.citation]),
      [[QUOTE_WARNING_REASON.ELISION_ACROSS_FOLIOS, { ark: FIGARO, folio: 1 }]],
    )
  })

  test("an exact quote yields no warning and quote_check.checked === 1", async () => {
    const result = (await noteCreateTool.handler(
      { title: "Foule", body_md: `## Foule\n\n${EXACT}` },
      ctxFor(),
    )) as Record<string, unknown>
    assert.deepEqual(checkOf(result), { status: "complete", checked: 1 })
    assert.equal(result["quote_warnings"], undefined)
  })

  test("a body with no checkable quote carries no quote_check at all", async () => {
    const result = (await noteCreateTool.handler(
      { title: "Sans citation", body_md: `## Résumé\n\nLe journal « Le Figaro » décrit la foule. ${FIGARO_CITE(1)}` },
      ctxFor(),
    )) as Record<string, unknown>
    assert.equal(checkOf(result), undefined)
    assert.equal(result["quote_warnings"], undefined)
  })

  test("note_update re-sending an unchanged pre-existing bad quote yields no warning (prior-body rule)", async () => {
    const created = (await noteCreateTool.handler(
      { title: "À corriger", body_md: `## Foule\n\n${STITCHED}` },
      ctxFor(),
    )) as Record<string, unknown>
    const noteId = created["note_id"] as string
    assert.equal(warningsOf(created).length, 1, "the create reported the stitch")

    const updated = (await noteUpdateTool.handler(
      { id: noteId, body_md: `## Foule (relue)\n\n${STITCHED}\n\nUn commentaire ajouté.` },
      ctxFor(),
    )) as Record<string, unknown>
    assert.equal(updated["error"], undefined)
    assert.equal(checkOf(updated), undefined, "nothing new to check")
    assert.equal(updated["quote_warnings"], undefined)

    const appended = (await noteAppendTool.handler(
      { id: noteId, body_md: `## Suite\n\n${EXACT}` },
      ctxFor(),
    )) as Record<string, unknown>
    assert.deepEqual(checkOf(appended), { status: "complete", checked: 1 })
    assert.equal(appended["quote_warnings"], undefined)
  })

  test("a thrown checker still returns note_id, with quote_check.status === 'failed'", async () => {
    const original = ClusterRagClient.getDocumentFolios
    ClusterRagClient.getDocumentFolios = async () => {
      throw new TypeError("unexpected")
    }
    let result: Record<string, unknown>
    try {
      result = (await noteCreateTool.handler(
        { title: "Checker en panne", body_md: `## Foule\n\n${EXACT}` },
        ctxFor(),
      )) as Record<string, unknown>
    } finally {
      ClusterRagClient.getDocumentFolios = original
    }
    assert.ok(typeof result["note_id"] === "string")
    assert.deepEqual(checkOf(result), { status: "failed", checked: 0 })
    assert.equal(result["quote_warnings"], undefined)
  })

  test("a derived-workspace context checks against corpusProjectId, not projectId", async () => {
    const derived = await ProjectService.create({
      name: "TEST buffer unit derived quote-guard",
      subtitle: "unit fixture",
      ownerId: userId,
    })
    const seen: string[] = []
    const original = ClusterRagClient.getDocumentFolios
    ClusterRagClient.getDocumentFolios = async (req) => {
      seen.push(req.projectId)
      return original(req)
    }
    try {
      const result = (await noteCreateTool.handler(
        { title: "Note dérivée", body_md: `## Foule\n\n${EXACT}` },
        { ...ctxFor(), projectId: derived.id, corpusProjectId: projectId },
      )) as Record<string, unknown>
      assert.ok(typeof result["note_id"] === "string")
      assert.deepEqual(checkOf(result), { status: "complete", checked: 1 })
    } finally {
      ClusterRagClient.getDocumentFolios = original
      await cleanupProject(derived.id)
    }
    assert.deepEqual(seen, [projectId])
  })
})
