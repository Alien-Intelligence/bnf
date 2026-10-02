// lib/agent/tools/policy-gate.test.ts
// Every MUTATING agent tool authorises through its Policy (found bug
// project_bnf_buffer_policy_gap, Track E Phase 5). The chat route authorises
// POSTing a turn, never every tool the turn calls: before this gate a read-only
// group member's corpus turn could commit a corpus version.
//
// Each tool's handler is called directly — the gate must hold even if the
// boundary gating or the route were bypassed — first as a READ-ONLY member
// (refused, nothing changes), then as the OWNER (the positive control: the same
// call goes through). Dry runs are reads and stay open to the reader.
//
// No real egress: the BnF MCP env is removed (corpus_search's owner call stops
// at "MCP not configured", past the gate), the documents the corpus tools add
// are pre-resolved (no background resolve is kicked), and the owner's
// ingest_submit runs on an empty project (a no-op job, no worker call).
import "server-only"

delete process.env.BNF_MCP_URL
delete process.env.BNF_MCP_TOKEN

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { PROJECT_ACCESS } from "@/lib/authz/project-access"
import { createTestUser, createTestProject, createTestSession, deleteTestUser } from "@/lib/testing/fixtures"
import { markHeadIngested } from "@/lib/testing/mark-ingested"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { BufferService } from "@/models/buffer/service"
import { CorpusService } from "@/models/corpus/service"
import { GroupService } from "@/models/groups/service"
import { NoteService } from "@/models/notes/service"
import { ProjectQueries } from "@/models/projects/queries"
import { ProjectSharingService } from "@/models/projects/service"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import type { PolicyUser } from "@/models/users/schema"
import {
  bufferAddTool,
  bufferClearTool,
  bufferCommitTool,
  bufferDiscardTool,
  bufferRemoveByFilterTool,
  corpusSearchTool,
} from "./buffer"
import { corpusAddTool, corpusRemoveByFilterTool, corpusRemoveTool } from "./corpus"
import { ingestSubmitTool } from "./ingest"
import { memoryWriteTool } from "./memory"
import { noteAppendTool, noteCreateTool, noteUpdateTool } from "./note"
import { AGENT_TOOLS, MUTATING_AGENT_TOOLS } from "./constants"
import { toolsForScope } from "./index"
import type { TurnScopedCtx } from "./registry-factory"

let ownerRow: User
let readerRow: User
let owner: PolicyUser
let reader: PolicyUser
let groupId: string
let project: Project
let emptyProject: Project
let corpusSession: string
let researchSession: string
let emptyCorpusSession: string
let noteId: string

const ARK = (n: number) => `ark:/12148/bpt6k${String(9_100_000 + n)}`

function ctx(
  user: PolicyUser,
  p: Project,
  appSessionId: string,
  scope: "corpus" | "research",
): TurnScopedCtx {
  return {
    signal: new AbortController().signal,
    request: new Request("http://localhost/test"),
    db: prisma,
    user,
    appSessionId,
    projectId: p.id,
    corpusProjectId: p.id,
    corpusReachable: true,
    scope,
  }
}

/** A resolved Document, so adding it to the corpus kicks no background resolve. */
async function resolvedDocument(projectId: string, ark: string) {
  await prisma.document.create({
    data: {
      ark,
      projectId,
      title: `Document ${ark}`,
      year: 1937,
      docType: "press",
      lang: "fr",
      source: "gallica",
      resolveStatus: "resolved",
    },
  })
}

/** Everything a mutating tool could change, for a before/after comparison. */
async function fingerprint(projectId: string) {
  const [versions, buffer, memory, notes, jobs] = await Promise.all([
    prisma.corpusVersion.count({ where: { projectId } }),
    prisma.bufferItem.findMany({ where: { projectId }, select: { ark: true, status: true }, orderBy: { ark: "asc" } }),
    prisma.memoryItem.count({ where: { projectId } }),
    prisma.note.findMany({ where: { projectId }, select: { id: true, title: true, body_md: true }, orderBy: { id: "asc" } }),
    prisma.ingestJob.count({ where: { projectId } }),
  ])
  return { versions, buffer, memory, notes, jobs }
}

type ToolCall = (c: TurnScopedCtx) => unknown

/** The mutating calls of the gate table, each with the scope its tool lives in. */
const MUTATIONS: Array<[string, "corpus" | "research", ToolCall]> = [
  [AGENT_TOOLS.corpusSearch, "corpus", (c) => corpusSearchTool.handler({ source: "gallica", query: "incendie" }, c)],
  [AGENT_TOOLS.bufferAdd, "corpus", (c) => bufferAddTool.handler({ arks: [ARK(50)] }, c)],
  [AGENT_TOOLS.bufferDiscard, "corpus", (c) => bufferDiscardTool.handler({ arks: [ARK(1), ARK(50)] }, c)],
  [
    AGENT_TOOLS.bufferRemoveByFilter,
    "corpus",
    (c) => bufferRemoveByFilterTool.handler({ filters: { source: ["gallica"] }, dry_run: false }, c),
  ],
  [AGENT_TOOLS.bufferCommit, "corpus", (c) => bufferCommitTool.handler({ reason: "test" }, c)],
  [AGENT_TOOLS.bufferClear, "corpus", (c) => bufferClearTool.handler({}, c)],
  [AGENT_TOOLS.corpusAdd, "corpus", (c) => corpusAddTool.handler({ arks: [ARK(20)], reason: "test" }, c)],
  [AGENT_TOOLS.corpusRemove, "corpus", (c) => corpusRemoveTool.handler({ arks: [ARK(10)], reason: "test" }, c)],
  [
    AGENT_TOOLS.corpusRemoveByFilter,
    "corpus",
    (c) => corpusRemoveByFilterTool.handler({ filters: { yearFrom: 1900 }, reason: "test", dry_run: false }, c),
  ],
  [AGENT_TOOLS.ingestSubmit, "corpus", (c) => ingestSubmitTool.handler({}, c)],
  [AGENT_TOOLS.memoryWrite, "research", (c) => memoryWriteTool.handler({ section: "Sources", text: "Source à risque" }, c)],
  [AGENT_TOOLS.noteCreate, "research", (c) => noteCreateTool.handler({ title: "Note", body_md: "Corps." }, c)],
  [AGENT_TOOLS.noteUpdate, "research", (c) => noteUpdateTool.handler({ id: noteId, body_md: "Réécrit." }, c)],
  [AGENT_TOOLS.noteAppend, "research", (c) => noteAppendTool.handler({ id: noteId, body_md: "Ajout." }, c)],
]

function isForbidden(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { forbidden?: unknown }).forbidden === true &&
    (result as { success?: unknown }).success === false
  )
}

before(async () => {
  ownerRow = await createTestUser()
  readerRow = await createTestUser()
  const group = await GroupService.create(`TEST policy gate ${randomUUID()}`)
  groupId = group.id
  owner = { ...ownerRow, groupIds: [] }
  reader = { ...readerRow, groupIds: [groupId] }

  project = await createTestProject(ownerRow.id, "policy-gate")
  emptyProject = await createTestProject(ownerRow.id, "policy-gate-ingest")
  for (const p of [project, emptyProject]) {
    const withShares = await ProjectQueries.get(p.id)
    assert.ok(withShares)
    await ProjectSharingService.share(withShares, ownerRow.id, { groupId, access: PROJECT_ACCESS.READ })
  }
  corpusSession = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  researchSession = await createTestSession(project.id, SESSION_SCOPE.RESEARCH)
  emptyCorpusSession = await createTestSession(emptyProject.id, SESSION_SCOPE.CORPUS)

  // Corpus: two resolved documents in head; ARK(20) and ARK(30) resolved but
  // not members (corpus_add and buffer_commit material for the owner).
  for (const n of [10, 11, 20, 30]) await resolvedDocument(project.id, ARK(n))
  await CorpusService.addArks(project, ownerRow, { arks: [ARK(10), ARK(11)], reason: "fixture" })
  await markHeadIngested(project.id)

  // Buffer: two candidates.
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [
      { ark: ARK(1), title: "Un", source: "gallica" },
      { ark: ARK(2), title: "Deux", source: "gallica" },
    ],
  })

  const { note } = await NoteService.create({
    projectId: project.id,
    corpusProjectId: project.id,
    appSessionId: researchSession,
    title: "Note existante",
    bodyMd: "Texte.",
  })
  noteId = note.id
})

after(async () => {
  await cleanupProject(project.id)
  await cleanupProject(emptyProject.id)
  await prisma.group.deleteMany({ where: { id: groupId } })
  await deleteTestUser(ownerRow.id)
  await deleteTestUser(readerRow.id)
})

test("a read-only member is refused by every mutating tool, and nothing changes", async () => {
  const beforeState = await fingerprint(project.id)
  for (const [name, scope, call] of MUTATIONS) {
    const session = scope === "corpus" ? corpusSession : researchSession
    const result = await call(ctx(reader, project, session, scope))
    assert.ok(isForbidden(result), `${name} must refuse a read-only member, got ${JSON.stringify(result)}`)
  }
  assert.deepEqual(await fingerprint(project.id), beforeState, "no corpus/buffer/memory/note/job change")
})

test("dry runs are reads: a read-only member may preview a removal", async () => {
  const bufferPreview = (await bufferRemoveByFilterTool.handler(
    { filters: { source: ["gallica"] }, dry_run: true },
    ctx(reader, project, corpusSession, "corpus"),
  )) as { status?: string }
  assert.equal(bufferPreview.status, "dry_run")

  const corpusPreview = (await corpusRemoveByFilterTool.handler(
    { filters: { yearFrom: 1900 }, reason: "aperçu", dry_run: true },
    ctx(reader, project, corpusSession, "corpus"),
  )) as { status?: string }
  assert.equal(corpusPreview.status, "dry_run")
})

test("positive control: the owner's same calls go through the gate", async () => {
  const asOwner = (scope: "corpus" | "research") =>
    ctx(owner, project, scope === "corpus" ? corpusSession : researchSession, scope)

  for (const [name, scope, call] of MUTATIONS) {
    if (name === AGENT_TOOLS.ingestSubmit) {
      // On the empty project: a no-op job, no worker round-trip.
      const result = (await call(ctx(owner, emptyProject, emptyCorpusSession, "corpus"))) as { job_id?: string }
      assert.ok(!isForbidden(result), `${name} as owner`)
      assert.equal(typeof result.job_id, "string", "the owner's ingest_submit created its (no-op) job")
      continue
    }
    if (name === AGENT_TOOLS.bufferCommit) {
      // Commit a candidate whose Document is already resolved.
      await BufferService.registerCandidates({
        projectId: project.id,
        originTool: "corpus_search",
        restageDiscarded: false,
        candidates: [{ ark: ARK(30), title: "Trente", source: "gallica" }],
      })
    }
    const result = await call(asOwner(scope))
    assert.ok(!isForbidden(result), `${name} must let the owner through, got ${JSON.stringify(result)}`)
  }

  // The owner's calls really mutated: versions advanced, a memory item and a
  // note exist, the existing note was rewritten.
  const after = await fingerprint(project.id)
  assert.ok(after.versions > 2, "corpus_add / remove / commit advanced versions")
  assert.equal(after.memory, 1)
  assert.equal(after.notes.length, 2)
  const rewritten = after.notes.find((n) => n.id === noteId)
  assert.ok(rewritten?.body_md.startsWith("Réécrit."), "note_update + note_append applied")
})

test("MUTATING_AGENT_TOOLS is exactly the gate table, and every entry is a registered tool", () => {
  assert.deepEqual(
    [...MUTATING_AGENT_TOOLS].sort(),
    MUTATIONS.map(([name]) => name).sort(),
    "a new mutating tool needs a gate decision here",
  )
  const registered = new Set([...toolsForScope("corpus"), ...toolsForScope("research")].map((t) => t.name))
  for (const name of MUTATING_AGENT_TOOLS) assert.ok(registered.has(name), `${name} is registered`)
})
