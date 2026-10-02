// lib/agent/tools/ocr-gate.test.ts
// The D8 gate and the revocation state at the agent-tool level (feedback
// 2026-09-29 #7, Track B). The OCR-quality tables are global per ARK, so a
// tool must only ever answer for Documents of the corpus the turn reads — the
// SOURCE's, in a derived workspace — and a derived workspace whose grant was
// revoked must read none of the source's Document/OCR rows, while still
// reading its own notes.
//
// Built the way production builds them (playbook/sharing.md checklist): a
// REAL share (group, membership, ProjectSharingService.share), a REAL derived
// workspace (ProjectService.createDerived, which pins corpusSourceShareId),
// a REAL revoke (ProjectSharingService.unshare, SetNull), and the turn ctx
// resolved from the stored project exactly as the messages route does
// (corpusProjectId / canReachCorpus). Plus an account granted nothing — its
// own ingested project, no share. All seven OCR-reading handlers run against
// those three ctx: rag_query, rag_keyword_search, rag_get_text, doc_get,
// note_get, note_list and the note-write OCR check. rag_query and
// rag_keyword_search use the in-process fake cluster (CLUSTER_MODE=fake),
// whose passages carry a fixture ARK the test seeds quality for.
import "server-only"

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"

import { prisma } from "@/lib/db"
import type { User } from "@/lib/generated/prisma/client"
import { canReachCorpus, corpusProjectId } from "@/lib/authz/corpus-source"
import { markHeadIngested } from "@/lib/testing/mark-ingested"
import {
  createTestProject,
  createTestSession,
  createTestUser,
  deleteTestUser,
} from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { RAG_FIXTURES } from "@/lib/cluster/rag-fixtures"
import {
  DOCUMENT_OCR_STATUS,
  FOLIO_OCR_STATE,
  OCR_ACCESS,
  OCR_SOURCE,
  OCR_SYNC_STATUS,
} from "@/models/documents/schema"
import { GroupService } from "@/models/groups/service"
import { ProjectQueries } from "@/models/projects/queries"
import { ProjectService, ProjectSharingService } from "@/models/projects/service"
import { SESSION_SCOPE } from "@/models/sessions/schema"

import {
  ARK_NOT_IN_CORPUS_ERROR,
  NOTE_INVALID_CITATION_MESSAGE,
  NOTE_LOW_OCR_NOTICE,
  NOTE_OCR_CORPUS_REVOKED_NOTICE,
} from "./constants"
import { docGetTool } from "./doc"
import { CORPUS_ACCESS_REVOKED_ERROR } from "./ingestion-guard"
import { noteCreateTool, noteGetTool, noteListTool } from "./note"
import { ragGetTextTool, ragKeywordSearchTool, ragQueryTool } from "./rag"
import type { TurnScopedCtx } from "./registry-factory"

const tag = randomBytes(4).toString("hex")
const ARK_SOURCE = `ark:/12148/zzgate${tag}s` // a Document of the source corpus
const ARK_WORKSPACE = `ark:/12148/zzgate${tag}w` // a Document of the workspace only
const ARK_BUILDING = `ark:/12148/zzgate${tag}b`
const ARK_QUARANTINED = `ark:/12148/zzgate${tag}q`
// The fake cluster's passages carry real seed ARKs: the first fixture's ARK is
// made a source Document with a stored LOW folio, so a leak would show.
const FIXTURE = RAG_FIXTURES[0]
const ARK_FIXTURE = FIXTURE.ark
const FIXTURE_FOLIO = FIXTURE.folio ?? 1
const FIXTURE_QUERY = FIXTURE.topics.join(" ")
const ARKS = [ARK_SOURCE, ARK_WORKSPACE, ARK_BUILDING, ARK_QUARANTINED, ARK_FIXTURE]

let owner: User
let member: User
let stranger: User
let groupId: string
let sourceId: string
let workspaceId: string
let strangerProjectId: string
let savedClusterMode: string | undefined
/** The research session of each project a ctx is built for (a note's appSessionId is a FK). */
const sessions = new Map<string, string>()

/** process.env stores strings: assigning undefined would store "undefined". */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** The turn ctx of `projectId`, resolved from the STORED project like the messages route. */
async function ctxOf(projectId: string, user: User): Promise<TurnScopedCtx> {
  const project = await ProjectQueries.get(projectId)
  assert.ok(project, `project ${projectId} exists`)
  const appSessionId = sessions.get(projectId)
  assert.ok(appSessionId, `project ${projectId} has a test session`)
  return {
    signal: new AbortController().signal,
    request: new Request("http://localhost/test"),
    db: prisma,
    user,
    appSessionId,
    projectId,
    corpusProjectId: corpusProjectId(project),
    corpusReachable: canReachCorpus(project),
    scope: "research",
  }
}

/** A project-scoped Document that is also a member of the project's head version. */
async function seedCorpusDocument(projectId: string, ark: string): Promise<void> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { headVersionId: true },
  })
  assert.ok(project.headVersionId, "fixture project has a head version")
  await prisma.document.create({ data: { projectId, ark, indexedAt: new Date() } })
  await prisma.corpusMembership.create({
    data: { versionId: project.headVersionId, ark, projectId },
  })
}

before(async () => {
  savedClusterMode = process.env.CLUSTER_MODE
  process.env.CLUSTER_MODE = "fake"

  // The fixture ARK's quality is global: a row already there (from a real
  // sync on this database) would make the assertions lie — refuse loudly.
  assert.equal(
    await prisma.documentOcr.count({ where: { ark: ARK_FIXTURE } }),
    0,
    `a document_ocr row for ${ARK_FIXTURE} already exists on this database`,
  )

  owner = await createTestUser()
  member = await createTestUser()
  stranger = await createTestUser()

  sourceId = (await createTestProject(owner.id, "ocr-gate-source")).id
  for (const ark of [ARK_SOURCE, ARK_BUILDING, ARK_QUARANTINED, ARK_FIXTURE]) {
    await seedCorpusDocument(sourceId, ark)
  }
  await markHeadIngested(sourceId)

  // A real grant: a group holding the member, the source shared to it at read.
  const group = await GroupService.create(`ocr-gate-${tag}`)
  groupId = group.id
  await GroupService.addMemberByEmail(groupId, member.email)
  const source = await ProjectQueries.get(sourceId)
  assert.ok(source)
  await ProjectSharingService.share(source, owner.id, { groupId, access: "read" })

  // A real derived workspace, pinned to that grant by createDerived.
  const shared = await ProjectQueries.get(sourceId)
  assert.ok(shared)
  const workspace = await ProjectService.createDerived({
    source: shared,
    user: { ...member, groupIds: [groupId] },
    name: `TEST buffer unit ocr-gate-workspace ${tag}`,
  })
  workspaceId = workspace.id
  assert.ok(workspace.corpusSourceShareId, "the workspace is pinned to the share")
  await prisma.document.create({
    data: { projectId: workspaceId, ark: ARK_WORKSPACE, indexedAt: new Date() },
  })

  // An account granted nothing: its own ingested project, no share.
  strangerProjectId = (await createTestProject(stranger.id, "ocr-gate-stranger")).id
  await markHeadIngested(strangerProjectId)
  for (const id of [workspaceId, strangerProjectId]) {
    sessions.set(id, await createTestSession(id, SESSION_SCOPE.RESEARCH))
  }

  const now = new Date()
  const available = (ark: string, folio: number, ocrQuality: number) =>
    prisma.documentOcr.create({
      data: {
        ark,
        status: OCR_SYNC_STATUS.AVAILABLE,
        ocrRate: 0.7821,
        checkedAt: now,
        syncedAt: now,
        folios: { create: [{ folio, ocrSource: OCR_SOURCE.ALTO, ocrQuality, wordCount: 4016 }] },
      },
    })
  await available(ARK_SOURCE, 2, 0.661)
  await available(ARK_WORKSPACE, 1, 0.1)
  await available(ARK_FIXTURE, FIXTURE_FOLIO, 0.5)
  await prisma.documentOcr.create({
    data: { ark: ARK_BUILDING, status: OCR_SYNC_STATUS.BUILDING, checkedAt: now },
  })
  await prisma.documentOcr.create({
    data: {
      ark: ARK_QUARANTINED,
      status: OCR_SYNC_STATUS.QUARANTINED,
      reason: "sync_rejected: test",
      checkedAt: now,
    },
  })
})

after(async () => {
  restoreEnv("CLUSTER_MODE", savedClusterMode)
  await prisma.documentOcr.deleteMany({ where: { ark: { in: ARKS } } })
  await cleanupProject(workspaceId)
  await cleanupProject(strangerProjectId)
  await cleanupProject(sourceId)
  await prisma.group.deleteMany({ where: { id: groupId } })
  for (const u of [owner, member, stranger]) await deleteTestUser(u.id)
})

// ---------------------------------------------------------------------------
// While the grant holds: the workspace reads the SOURCE corpus, and only it
// ---------------------------------------------------------------------------

test("doc_get on the derived workspace answers for the SOURCE corpus document", async () => {
  const result = (await docGetTool.handler(
    { ark: ARK_SOURCE },
    await ctxOf(workspaceId, member),
  )) as Record<string, unknown>
  assert.deepEqual(result["ocr"], {
    status: OCR_SYNC_STATUS.AVAILABLE,
    ocrRate: 0.7821,
    scoredFolios: 1,
    lowFolios: [2],
    lowFolioCount: 1,
  })
})

test("doc_get refuses the workspace's own document, even with stored quality", async () => {
  const result = (await docGetTool.handler(
    { ark: ARK_WORKSPACE },
    await ctxOf(workspaceId, member),
  )) as Record<string, unknown>
  assert.equal(result["error"], ARK_NOT_IN_CORPUS_ERROR)
  assert.equal(result["ocr"], undefined)
})

test("doc_get: building / quarantined carry no counts — unknown, never 'nothing low'", async () => {
  const ctx = await ctxOf(workspaceId, member)
  for (const [ark, status] of [
    [ARK_BUILDING, OCR_SYNC_STATUS.BUILDING],
    [ARK_QUARANTINED, OCR_SYNC_STATUS.QUARANTINED],
  ] as const) {
    const result = (await docGetTool.handler({ ark }, ctx)) as Record<string, unknown>
    assert.deepEqual(result["ocr"], {
      status,
      ocrRate: null,
      scoredFolios: null,
      lowFolios: null,
      lowFolioCount: null,
    })
  }
})

test("rag_query on the derived workspace annotates the source folio as recorded and low", async () => {
  const result = (await ragQueryTool.handler(
    { query: FIXTURE_QUERY },
    await ctxOf(workspaceId, member),
  )) as { passages: Array<{ ark: string; folio: number | null; ocrState: string; ocrLow: boolean }> }
  const hit = result.passages.find((p) => p.ark === ARK_FIXTURE && p.folio === FIXTURE_FOLIO)
  assert.ok(hit, "the fake cluster returns the fixture passage")
  assert.equal(hit.ocrState, FOLIO_OCR_STATE.RECORDED)
  assert.equal(hit.ocrLow, true)
})

test("rag_keyword_search on the derived workspace carries the source document's low folios", async () => {
  const result = (await ragKeywordSearchTool.handler(
    { query: FIXTURE_QUERY },
    await ctxOf(workspaceId, member),
  )) as { hits: Array<{ ark: string; ocrStatus: string; ocrLowFolioCount: number | null }> }
  const hit = result.hits.find((h) => h.ark === ARK_FIXTURE)
  assert.ok(hit, "the fake cluster returns the fixture document")
  assert.equal(hit.ocrStatus, OCR_SYNC_STATUS.AVAILABLE)
  assert.equal(hit.ocrLowFolioCount, 1)
})

test("rag_get_text on the derived workspace refuses an ARK outside the source corpus", async () => {
  const result = (await ragGetTextTool.handler(
    { entryId: 1, ark: ARK_WORKSPACE },
    await ctxOf(workspaceId, member),
  )) as Record<string, unknown>
  assert.deepEqual(result, { text: "", error: ARK_NOT_IN_CORPUS_ERROR, ark: ARK_WORKSPACE })
})

test("note_create on the derived workspace reports the source folio's low quality", async () => {
  const result = (await noteCreateTool.handler(
    { title: "Note OCR gate", body_md: `[[${ARK_SOURCE}|Source|2]]` },
    await ctxOf(workspaceId, member),
  )) as Record<string, unknown>
  assert.deepEqual(result["low_ocr_citations"], {
    citations: [{ ark: ARK_SOURCE, folio: 2, ocr_quality: 0.661 }],
    message: NOTE_LOW_OCR_NOTICE,
  })
})

// ---------------------------------------------------------------------------
// An account granted nothing reads none of the source's rows
// ---------------------------------------------------------------------------

test("granted nothing: doc_get and rag_get_text refuse the source ARK", async () => {
  const ctx = await ctxOf(strangerProjectId, stranger)
  const doc = (await docGetTool.handler({ ark: ARK_SOURCE }, ctx)) as Record<string, unknown>
  assert.equal(doc["error"], ARK_NOT_IN_CORPUS_ERROR)
  assert.equal(doc["ocr"], undefined)
  const text = (await ragGetTextTool.handler({ entryId: 1, ark: ARK_SOURCE }, ctx)) as Record<string, unknown>
  assert.deepEqual(text, { text: "", error: ARK_NOT_IN_CORPUS_ERROR, ark: ARK_SOURCE })
})

test("granted nothing: rag_query and rag_keyword_search never surface the stored quality", async () => {
  const ctx = await ctxOf(strangerProjectId, stranger)
  const query = (await ragQueryTool.handler({ query: FIXTURE_QUERY }, ctx)) as {
    passages: Array<{ ark: string; folio: number | null; ocrState: string; ocrQuality: number | null }>
  }
  const passage = query.passages.find((p) => p.ark === ARK_FIXTURE && p.folio === FIXTURE_FOLIO)
  assert.ok(passage, "the fake cluster returns the fixture passage")
  assert.equal(passage.ocrState, FOLIO_OCR_STATE.PENDING)
  assert.equal(passage.ocrQuality, null)

  const keyword = (await ragKeywordSearchTool.handler({ query: FIXTURE_QUERY }, ctx)) as {
    hits: Array<{ ark: string; ocrStatus: string; ocrLowFolios: number[] | null }>
  }
  const hit = keyword.hits.find((h) => h.ark === ARK_FIXTURE)
  assert.ok(hit, "the fake cluster returns the fixture document")
  assert.equal(hit.ocrStatus, DOCUMENT_OCR_STATUS.PENDING)
  assert.equal(hit.ocrLowFolios, null)
})

test("granted nothing: a note citing the source ARK is rejected and never reported", async () => {
  const ctx = await ctxOf(strangerProjectId, stranger)
  const result = (await noteCreateTool.handler(
    { title: "Note étrangère", body_md: `[[${ARK_SOURCE}|Source|2]]` },
    ctx,
  )) as Record<string, unknown>
  assert.deepEqual(result["invalid_citation"], {
    arks: [ARK_SOURCE],
    message: NOTE_INVALID_CITATION_MESSAGE,
  })
  assert.equal(result["low_ocr_citations"], undefined)
  assert.equal(result["ocr_unknown_citations"], undefined)

  const listed = (await noteListTool.handler({}, ctx)) as {
    notes: Array<{ low_ocr_citation_count: number | null; ocr_unknown_citation_count: number | null }>
  }
  assert.deepEqual(
    listed.notes.map((n) => [n.low_ocr_citation_count, n.ocr_unknown_citation_count]),
    [[0, 0]],
  )
})

// ---------------------------------------------------------------------------
// After a REAL revoke: the workspace keeps its notes, reads no source row.
// Runs last: it revokes the grant the tests above rely on.
// ---------------------------------------------------------------------------

test("revoked: the stored project is in the revoked state, and the ctx says so", async () => {
  await ProjectSharingService.unshare(sourceId, groupId)
  const workspace = await ProjectQueries.get(workspaceId)
  assert.ok(workspace)
  assert.equal(workspace.corpusSourceId, sourceId)
  assert.equal(workspace.corpusSourceShareId, null)
  const ctx = await ctxOf(workspaceId, member)
  assert.equal(ctx.corpusReachable, false)
  assert.equal(ctx.corpusProjectId, sourceId)
})

test("revoked: doc_get, rag_query, rag_keyword_search and rag_get_text answer the revocation", async () => {
  const ctx = await ctxOf(workspaceId, member)
  const doc = (await docGetTool.handler({ ark: ARK_SOURCE }, ctx)) as Record<string, unknown>
  assert.deepEqual(doc, { error: CORPUS_ACCESS_REVOKED_ERROR })
  const query = (await ragQueryTool.handler({ query: FIXTURE_QUERY }, ctx)) as Record<string, unknown>
  assert.deepEqual(query, { passages: [], total: 0, error: CORPUS_ACCESS_REVOKED_ERROR })
  const keyword = (await ragKeywordSearchTool.handler({ query: FIXTURE_QUERY }, ctx)) as Record<string, unknown>
  assert.deepEqual(keyword, { hits: [], total: 0, error: CORPUS_ACCESS_REVOKED_ERROR })
  const text = (await ragGetTextTool.handler({ entryId: 1, ark: ARK_SOURCE }, ctx)) as Record<string, unknown>
  assert.deepEqual(text, { text: "", error: CORPUS_ACCESS_REVOKED_ERROR })
})

test("revoked: note_get returns the note with an explicit corpus_revoked OCR state", async () => {
  const ctx = await ctxOf(workspaceId, member)
  const note = await prisma.note.findFirstOrThrow({ where: { projectId: workspaceId, title: "Note OCR gate" } })
  const got = (await noteGetTool.handler({ id: note.id }, ctx)) as Record<string, unknown>
  assert.ok(got["note"], "the workspace's own note is still returned")
  assert.deepEqual(got["ocr_check"], {
    status: OCR_ACCESS.CORPUS_REVOKED,
    message: NOTE_OCR_CORPUS_REVOKED_NOTICE,
  })
  assert.equal(got["low_ocr_citations"], undefined, "no source OCR row is read")
})

test("revoked: note_list lists the notes, counts unknown (null) and says why", async () => {
  const ctx = await ctxOf(workspaceId, member)
  const listed = (await noteListTool.handler({}, ctx)) as {
    notes: Array<{ title: string; low_ocr_citation_count: number | null; ocr_unknown_citation_count: number | null }>
    ocr_check?: { status: string }
  }
  assert.deepEqual(
    listed.notes.map((n) => [n.title, n.low_ocr_citation_count, n.ocr_unknown_citation_count]),
    [["Note OCR gate", null, null]],
  )
  assert.equal(listed.ocr_check?.status, OCR_ACCESS.CORPUS_REVOKED)
})

test("revoked: a note write is refused before anything is written or read", async () => {
  const ctx = await ctxOf(workspaceId, member)
  const before = await prisma.note.count({ where: { projectId: workspaceId } })
  const result = (await noteCreateTool.handler(
    { title: "Après révocation", body_md: `[[${ARK_SOURCE}|Source|2]]` },
    ctx,
  )) as Record<string, unknown>
  assert.deepEqual(result, { error: CORPUS_ACCESS_REVOKED_ERROR })
  assert.equal(await prisma.note.count({ where: { projectId: workspaceId } }), before)
})
