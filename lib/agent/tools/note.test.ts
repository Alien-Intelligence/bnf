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
import {
  noteCreateTool,
  noteGetTool,
  noteListTool,
  noteResult,
  type NoteOcrOutcome,
} from "./note"
import {
  NOTE_LOW_OCR_NOTICE,
  NOTE_OCR_CHECK_FAILED_NOTICE,
  NOTE_OCR_UNKNOWN_NOTICE,
} from "./constants"
import {
  FOLIO_OCR_STATE,
  OCR_ACCESS,
  OCR_SOURCE,
  OCR_SYNC_STATUS,
} from "@/models/documents/schema"
import { handleNoteAppend, handleNoteCreate, handleNoteUpdate } from "./note"
import type { NoteWriteOutcome } from "./note"
import { NOTE_NOT_INGESTED_ERROR } from "./ingestion-guard"
import { toolCallErrored } from "@/lib/tools/display"
import type { TurnScopedCtx } from "./registry-factory"
import {
  createTestUser,
  createTestProject,
  createTestSession,
  deleteTestUser,
} from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import type { PolicyUser } from "@/models/users/schema"
import { ClusterRagClient } from "@/lib/cluster/rag"
import { CLUSTER_MODE } from "@/lib/cluster/mode"
import { seedCorpusDocuments } from "@/lib/testing/seed-corpus"
import { markHeadIngested } from "@/lib/testing/mark-ingested"
import {
  QUOTE_CHECK_STATUS,
  QUOTE_WARNING_REASON,
  type NoteToolResult,
  type QuoteCheckResult,
  type QuoteCitation,
  type QuoteWarningReason,
} from "@/models/notes/schema"
import { ProjectService } from "@/models/projects/service"

let user: TurnScopedCtx["user"]
let userId: string
let policyUser: PolicyUser
let projectId: string
let sessionId: string

function ctxFor(): TurnScopedCtx {
  return {
    signal: new AbortController().signal,
    request: new Request("http://localhost/test"),
    db: prisma,
    user: policyUser,
    appSessionId: sessionId,
    projectId,
    // This project owns its corpus, so the corpus id is its own and the grant
    // question does not arise. Every field spelled out, none cast: a new field
    // on TurnScopedCtx must be a decision here, not a silent undefined.
    corpusProjectId: projectId,
    corpusReachable: true,
    scope: SESSION_SCOPE.RESEARCH,
  }
}

before(async () => {
  user = { ...(await createTestUser()), groupIds: [] }
  userId = user.id
  // The owner: the note tools authorise through NotePolicy before writing.
  policyUser = { ...user, groupIds: [] }
  const project = await createTestProject(userId, "note-guard")
  projectId = project.id
  sessionId = await createTestSession(projectId, SESSION_SCOPE.RESEARCH)
})

after(async () => {
  await cleanupProject(projectId)
  await deleteTestUser(userId)
})

/** The note was written: narrow the outcome, failing the test on a refusal. */
function written(outcome: NoteWriteOutcome): NoteToolResult {
  assert.ok(!("error" in outcome), `the write was refused: ${JSON.stringify(outcome)}`)
  return outcome
}

/**
 * The write was refused: return its error. A refusal must be recorded as a
 * failed call (success: false → toolCallErrored), not as an "ok" with a ✓.
 */
function refusal(outcome: NoteWriteOutcome): string {
  assert.ok("error" in outcome, `the write was not refused: ${JSON.stringify(outcome)}`)
  assert.equal(outcome.success, false)
  assert.equal(toolCallErrored(false, outcome), true, "persisted and displayed as an error")
  return outcome.error
}

// --- Nothing ingested → every write tool refuses --------------------------

test("note_create is refused when ingestedVersionId is null", async () => {
  const before = await prisma.note.count({ where: { projectId } })
  const outcome = await handleNoteCreate({ title: "Note prématurée", body_md: "Ceci ne doit pas être écrit." }, ctxFor())
  assert.equal(refusal(outcome), NOTE_NOT_INGESTED_ERROR)
  assert.equal(await prisma.note.count({ where: { projectId } }), before, "no note row created")
})

test("note_update is refused when ingestedVersionId is null (guard before lookup)", async () => {
  // A random UUID is fine: the guard fires before NoteService.update runs, so
  // the note need not exist. If the guard were removed, this would 500 on a
  // missing note instead — still a refusal, but not the structural one we want.
  const outcome = await handleNoteUpdate({ id: randomUUID(), title: "x", body_md: "y" }, ctxFor())
  assert.equal(refusal(outcome), NOTE_NOT_INGESTED_ERROR)
})

test("note_append is refused when ingestedVersionId is null (guard before lookup)", async () => {
  const outcome = await handleNoteAppend({ id: randomUUID(), body_md: "z" }, ctxFor())
  assert.equal(refusal(outcome), NOTE_NOT_INGESTED_ERROR)
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
  const result = written(
    await handleNoteCreate({ title: "Note fondée sur le corpus", body_md: "## Résumé\n\nUn contenu valide." }, ctxFor()),
  )
  assert.equal(typeof result.note_id, "string", "returns a note_id")
  assert.equal(
    await prisma.note.count({ where: { projectId } }),
    before + 1,
    "exactly one note row created",
  )
})

// --- OCR quality in the note results (feedback 2026-09-29 #7) -------------

const WRITTEN = { id: "00000000-0000-4000-8000-000000000001", title: "Note", citationCount: 2 }
const NOTHING: NoteOcrOutcome = { kind: OCR_ACCESS.OK, report: { low: [], unknown: [] } }

test("noteResult with nothing to say about OCR is byte-identical to before", () => {
  assert.equal(
    JSON.stringify(noteResult(WRITTEN, [], [], NOTHING)),
    JSON.stringify({ note_id: WRITTEN.id, title: WRITTEN.title, citation_count: 2 }),
  )
})

test("noteResult reports low and unknown citations with their notices", () => {
  const low = [{ ark: "ark:/12148/bpt6k4625753w", folio: 2, ocr_quality: 0.661 }]
  const unknown = [{ ark: "ark:/12148/bpt6k4625753w", folio: 5, ocr_state: FOLIO_OCR_STATE.PENDING }]
  assert.deepEqual(noteResult(WRITTEN, [], [], { kind: OCR_ACCESS.OK, report: { low, unknown } }), {
    note_id: WRITTEN.id,
    title: WRITTEN.title,
    citation_count: 2,
    low_ocr_citations: { citations: low, message: NOTE_LOW_OCR_NOTICE },
    ocr_unknown_citations: { citations: unknown, message: NOTE_OCR_UNKNOWN_NOTICE },
  })
})

test("noteResult after a failed OCR check still reports the write, never an error", () => {
  const result = noteResult(WRITTEN, [], [], { kind: OCR_ACCESS.CHECK_FAILED })
  assert.equal(result.note_id, WRITTEN.id)
  assert.deepEqual(result.ocr_check, {
    status: OCR_ACCESS.CHECK_FAILED,
    message: NOTE_OCR_CHECK_FAILED_NOTICE,
  })
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
    citations: [{ ark: OCR_ARK, folio: 7, ocr_state: FOLIO_OCR_STATE.NOT_RECORDED }],
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
  assert.deepEqual(got["ocr_unknown_citations"], {
    citations: [{ ark: OCR_ARK, folio: 7, ocr_state: FOLIO_OCR_STATE.NOT_RECORDED }],
    message: NOTE_OCR_UNKNOWN_NOTICE,
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
  // The turn is aborted AFTER the write (its note_event is the first thing
  // emitted once the note is committed): the OCR read then fails.
  const turn = new AbortController()
  const before = await prisma.note.count({ where: { projectId } })
  const result = (await noteCreateTool.handler(
    { title: "Note OCR check failed", body_md: `[[${OCR_ARK}|Source|2]]` },
    { ...ctxFor(), signal: turn.signal, emit: () => turn.abort() },
  )) as Record<string, unknown>
  assert.equal(await prisma.note.count({ where: { projectId } }), before + 1, "the note is written")
  assert.ok(typeof result["note_id"] === "string")
  assert.deepEqual(result["ocr_check"], {
    status: OCR_ACCESS.CHECK_FAILED,
    message: NOTE_OCR_CHECK_FAILED_NOTICE,
  })
})

// --- Quote guard: every agent note write checks its quotes ------------------
//
// The guard runs against the FAKE cluster (CLUSTER_MODE=fake, set below for
// this process), whose entry text is assembled from lib/cluster/rag-fixtures.ts
// in the same folio-headed format worker-v2 writes. Le Figaro, 6 mai 1889:
// folio 1 ends « … se pressait aux abords du Champ de Mars. », folio 2 holds
// « C'est la fête du travail et de la paix … ».
//
// The note tools pass Track B's stored folio quality as the low-OCR lookup, so
// a check with nothing wrong is `complete`: every rule was evaluated.

const FIGARO = "ark:/12148/bpt6k2839841"
const FIGARO_CITE = (folio: number) => `[[${FIGARO}|Le Figaro, 6 mai 1889|${folio}]]`
const STITCHED =
  `« Dès l'aube, une foule considérable se pressait aux abords du Champ de Mars […] ` +
  `C'est la fête du travail et de la paix » ${FIGARO_CITE(1)}`
const EXACT = `« une foule considérable se pressait aux abords du Champ de Mars » ${FIGARO_CITE(1)}`

/** What a check with `checked` quotes in scope and every rule evaluated reports. */
function checkedComplete(checked: number): NoteToolResult["quote_check"] {
  return { status: QUOTE_CHECK_STATUS.COMPLETE, checked }
}

function reasonsAndCitations(result: NoteToolResult): Array<[QuoteWarningReason, QuoteCitation | null]> {
  return (result.quote_warnings ?? []).map((w) => [w.reason, w.citation])
}

// A suite of its own: its `before` runs when the suite starts, AFTER the
// not-ingested tests above have had the project in its un-ingested state.
describe("quote guard", () => {
  const clusterModeBefore = process.env.CLUSTER_MODE
  before(async () => {
    process.env.CLUSTER_MODE = CLUSTER_MODE.FAKE
    await seedCorpusDocuments(projectId, [{ ark: FIGARO, title: "Le Figaro" }], `user:${userId}`)
    await markHeadIngested(projectId)
  })

  after(() => {
    if (clusterModeBefore === undefined) delete process.env.CLUSTER_MODE
    else process.env.CLUSTER_MODE = clusterModeBefore
  })

  test("note_create with a quote stitched across two folios returns quote_warnings[elision_across_folios]", async () => {
    const result = written(await handleNoteCreate({ title: "Inauguration", body_md: `## Foule\n\n${STITCHED}` }, ctxFor()))
    assert.deepEqual(result.quote_check, checkedComplete(1))
    assert.deepEqual(reasonsAndCitations(result), [
      [QUOTE_WARNING_REASON.ELISION_ACROSS_FOLIOS, { ark: FIGARO, folio: 1 }],
    ])
  })

  test("an exact quote yields no warning and quote_check.checked === 1", async () => {
    const result = written(await handleNoteCreate({ title: "Foule", body_md: `## Foule\n\n${EXACT}` }, ctxFor()))
    assert.deepEqual(result.quote_check, checkedComplete(1))
    assert.equal(result.quote_warnings, undefined)
  })

  test("a body with no checkable quote carries no quote_check at all", async () => {
    const result = written(
      await handleNoteCreate(
        { title: "Sans citation", body_md: `## Résumé\n\nLe journal « Le Figaro » décrit la foule. ${FIGARO_CITE(1)}` },
        ctxFor(),
      ),
    )
    assert.equal(result.quote_check, undefined)
    assert.equal(result.quote_warnings, undefined)
  })

  test("note_update re-sending an unchanged pre-existing bad quote yields no warning (prior-body rule)", async () => {
    const created = written(await handleNoteCreate({ title: "À corriger", body_md: `## Foule\n\n${STITCHED}` }, ctxFor()))
    assert.equal(created.quote_warnings?.length, 1, "the create reported the stitch")

    const updated = written(
      await handleNoteUpdate(
        { id: created.note_id, body_md: `## Foule (relue)\n\n${STITCHED}\n\nUn commentaire ajouté.` },
        ctxFor(),
      ),
    )
    assert.equal(updated.quote_check, undefined, "nothing new to check")
    assert.equal(updated.quote_warnings, undefined)

    const appended = written(await handleNoteAppend({ id: created.note_id, body_md: `## Suite\n\n${EXACT}` }, ctxFor()))
    assert.deepEqual(appended.quote_check, checkedComplete(1))
    assert.equal(appended.quote_warnings, undefined)
  })

  test("a thrown checker still returns note_id, with quote_check.status === 'failed'", async () => {
    const original = ClusterRagClient.getDocumentFolios
    ClusterRagClient.getDocumentFolios = async () => {
      throw new TypeError("unexpected")
    }
    let outcome: NoteWriteOutcome
    try {
      outcome = await handleNoteCreate({ title: "Checker en panne", body_md: `## Foule\n\n${EXACT}` }, ctxFor())
    } finally {
      ClusterRagClient.getDocumentFolios = original
    }
    const result = written(outcome)
    const failed: Pick<QuoteCheckResult, "status" | "checked"> = { status: QUOTE_CHECK_STATUS.FAILED, checked: 0 }
    assert.deepEqual(result.quote_check, failed)
    assert.equal(result.quote_warnings, undefined)
  })

  test("a bracketed correction on a folio stored as low OCR returns correction_on_low_ocr", async () => {
    // A fake-cluster document no other test stores OCR quality for (the
    // quality is global per ARK and the files run in parallel). Its folio 12
    // reads « … le visiteur empruntera l'ascenseur Otis … ».
    const GUIDE = "ark:/12148/bpt6k6529871"
    await seedCorpusDocuments(projectId, [{ ark: GUIDE, title: "Guide bleu" }], `user:${userId}`)
    await prisma.documentOcr.create({
      data: {
        ark: GUIDE,
        status: OCR_SYNC_STATUS.AVAILABLE,
        ocrRate: 0.5,
        checkedAt: new Date(),
        syncedAt: new Date(),
        folios: { create: [{ folio: 12, ocrSource: OCR_SOURCE.ALTO, ocrQuality: 0.5, wordCount: 900 }] },
      },
    })
    try {
      const corrected = `« le [visiteur] empruntera l'ascenseur Otis » [[${GUIDE}|Guide bleu|12]]`
      const result = written(
        await handleNoteCreate({ title: "Ascenseur", body_md: `## Visite\n\n${corrected}` }, ctxFor()),
      )
      assert.deepEqual(reasonsAndCitations(result), [
        [QUOTE_WARNING_REASON.CORRECTION_ON_LOW_OCR, { ark: GUIDE, folio: 12 }],
      ])
      assert.equal(result.quote_check?.unevaluated_rules, undefined, "the rule was evaluated")
    } finally {
      await prisma.documentOcr.delete({ where: { ark: GUIDE } })
    }
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
      const result = written(
        await handleNoteCreate(
          { title: "Note dérivée", body_md: `## Foule\n\n${EXACT}` },
          { ...ctxFor(), projectId: derived.id, corpusProjectId: projectId },
        ),
      )
      assert.deepEqual(result.quote_check, checkedComplete(1))
    } finally {
      ClusterRagClient.getDocumentFolios = original
      await cleanupProject(derived.id)
    }
    assert.deepEqual(seen, [projectId])
  })

  test("a citation with folio 0 is reported to the agent as invalid_citation, not silently dropped", async () => {
    const result = written(
      await handleNoteCreate(
        { title: "Folio zéro", body_md: `## Foule\n\nUne foule ${FIGARO_CITE(0)} et ${FIGARO_CITE(1)}.` },
        ctxFor(),
      ),
    )
    assert.equal(result.citation_count, 1, "only the folio-1 citation is projected")
    assert.deepEqual(result.invalid_citation?.folios, [{ ark: FIGARO, folio: "0" }])
    assert.deepEqual(result.invalid_citation?.arks, [])
  })

  test("invalid_citation has one scope — the note's full body — for note_append too", async () => {
    const created = written(
      await handleNoteCreate(
        { title: "Sans folio", body_md: `## Foule\n\nUne foule [[${FIGARO}|Le Figaro]] immense.` },
        ctxFor(),
      ),
    )
    assert.deepEqual(created.invalid_citation?.folios, [{ ark: FIGARO, folio: "" }], "a missing folio is reported")
    const appended = written(await handleNoteAppend({ id: created.note_id, body_md: `Suite ${FIGARO_CITE(2)}.` }, ctxFor()))
    // The merged body still holds the folio-less citation: reported again,
    // exactly as an unknown ARK in the merged body would be.
    assert.deepEqual(appended.invalid_citation?.folios, [{ ark: FIGARO, folio: "" }])
    assert.deepEqual(appended.invalid_citation?.arks, [])
  })
})
