// tests/models/buffer/enricher.test.ts
// Background enrichment of bare buffer rows (Track E Phase 9). On 0.18.1 a
// buffer_add row stayed bare forever — 99 % of the 17 422 prod buffer_add rows
// had no title — so the filters had nothing to work on. The drain fills them:
// first from a resolved same-project Document (zero BnF cost), otherwise
// through the broker-routed direct client. The client is injected and counts
// its calls, so the zero-cost path is proven to make none and the BnF path to
// make some (a negative result can never come from a dead fake).
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import type { BnfMcpDocumentDetail, BnfMcpResolveError, BnfMcpResolveResult } from "@/lib/bnf/types"
import { BUFFER_ENRICH_BATCH_SIZE, BUFFER_ENRICH_DRAIN_MAX_BATCHES, BUFFER_ENRICH_MAX_ATTEMPTS } from "@/lib/constants"
import { enrichPendingForProject, type BufferEnrichClient } from "@/lib/buffer/enricher"
import { BnfMcpError, BnfMcpNotFoundError } from "@/lib/mcp/errors"
import { BufferService } from "@/models/buffer/service"
import { BUFFER_ENRICH_STATUS } from "@/models/buffer/schema"
import { createTestUser, createTestProject, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"

let user: User
const projects: string[] = []

async function freshProject(label: string): Promise<Project> {
  const p = await createTestProject(user.id, label)
  projects.push(p.id)
  return p
}

const ARK = (n: number) => `ark:/12148/bpt6k${String(9_300_000 + n)}`

/** A fake staging client: answers from `respond`, counts every ARK it is asked for. */
function fakeClient(
  respond: (ark: string) => BnfMcpResolveResult | BnfMcpResolveError,
): BufferEnrichClient & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    async resolveArksForStaging(arks: string[]) {
      asked.push(...arks)
      return arks.map(respond)
    },
  }
}

/** Stage bare ARKs exactly as buffer_add does. */
async function stageBare(projectId: string, arks: string[]) {
  await BufferService.registerCandidates({
    projectId,
    originTool: "buffer_add",
    restageDiscarded: true,
    candidates: arks.map((ark) => ({ ark })),
  })
}

async function row(projectId: string, ark: string) {
  return prisma.bufferItem.findUniqueOrThrow({ where: { projectId_ark: { projectId, ark } } })
}

before(async () => {
  user = await createTestUser()
})

after(async () => {
  for (const id of projects) await cleanupProject(id)
  await deleteTestUser(user.id)
})

test("a resolved same-project Document fills the row with ZERO client calls", async () => {
  const project = await freshProject("enrich-document")
  await prisma.document.create({
    data: {
      ark: ARK(1),
      projectId: project.id,
      title: "Le Petit Journal",
      author: "Collectif",
      year: 1937,
      dateLabel: "1937-07-12",
      docType: "press",
      lang: "fr",
      source: "gallica",
      resolveStatus: "resolved",
    },
  })
  await stageBare(project.id, [ARK(1)])
  const client = fakeClient(() => {
    throw new Error("the Document path must not call BnF")
  })
  await enrichPendingForProject(project.id, { client })
  assert.deepEqual(client.asked, [])
  const r = await row(project.id, ARK(1))
  assert.equal(r.title, "Le Petit Journal")
  assert.equal(r.creator, "Collectif")
  assert.equal(r.arkKind, "periodical_issue")
  assert.equal(r.enrichStatus, BUFFER_ENRICH_STATUS.RESOLVED)
})

test("without a Document, an OAI record with the fascicules typedoc gives press / periodical_issue", async () => {
  const project = await freshProject("enrich-oai")
  await stageBare(project.id, [ARK(2)])
  const detail: BnfMcpDocumentDetail = {
    ark: "bpt6k9300002",
    title: "La Dépêche",
    creator: "Collectif",
    date: "1937-07-14",
    doc_type: "texte",
    gallica_typedoc: "periodiques:fascicules",
    language: "fre",
    publisher: "Imprimerie de la Dépêche",
    gallica_url: "https://gallica.bnf.fr/ark:/12148/bpt6k9300002",
  }
  const client = fakeClient((ark) => ({ ark, ok: true, document: detail }))
  await enrichPendingForProject(project.id, { client })
  assert.deepEqual(client.asked, [ARK(2)], "the BnF path is really taken (positive control)")
  const r = await row(project.id, ARK(2))
  assert.equal(r.title, "La Dépêche")
  assert.equal(r.docType, "press")
  assert.equal(r.docTypeRaw, "texte")
  assert.equal(r.arkKind, "periodical_issue")
  assert.equal(r.year, 1937)
  assert.equal(r.dateLabel, "1937-07-14")
  assert.equal(r.lang, "fr")
  assert.equal(r.publisher, "Imprimerie de la Dépêche")
  assert.equal(r.gallicaUrl, "https://gallica.bnf.fr/ark:/12148/bpt6k9300002")
  assert.equal(r.enrichStatus, BUFFER_ENRICH_STATUS.RESOLVED)
})

test("a transient failure increments attempts; the last allowed one marks the row failed", async () => {
  const project = await freshProject("enrich-retry")
  await stageBare(project.id, [ARK(3)])
  const client = fakeClient((ark) => ({ ark, ok: false, error: new BnfMcpError("broker 503") }))
  for (let attempt = 1; attempt <= BUFFER_ENRICH_MAX_ATTEMPTS; attempt++) {
    await enrichPendingForProject(project.id, { client })
    const r = await row(project.id, ARK(3))
    assert.equal(r.enrichAttempts, attempt)
    assert.equal(
      r.enrichStatus,
      attempt < BUFFER_ENRICH_MAX_ATTEMPTS ? BUFFER_ENRICH_STATUS.PENDING : BUFFER_ENRICH_STATUS.FAILED,
    )
    assert.match(r.enrichError ?? "", /broker 503/)
  }
  // A failed row is never picked up again.
  await enrichPendingForProject(project.id, { client })
  assert.equal(client.asked.length, BUFFER_ENRICH_MAX_ATTEMPTS)
})

test("an ARK the BnF does not know is failed at once", async () => {
  const project = await freshProject("enrich-notfound")
  await stageBare(project.id, [ARK(4)])
  const client = fakeClient((ark) => ({ ark, ok: false, error: new BnfMcpNotFoundError("no record") }))
  await enrichPendingForProject(project.id, { client })
  const r = await row(project.id, ARK(4))
  assert.equal(r.enrichStatus, BUFFER_ENRICH_STATUS.FAILED)
  assert.equal(r.enrichAttempts, 1)
})

test("one drain is bounded: it stops at the batch ceiling", async () => {
  const project = await freshProject("enrich-bound")
  const bound = BUFFER_ENRICH_BATCH_SIZE * BUFFER_ENRICH_DRAIN_MAX_BATCHES
  await stageBare(
    project.id,
    Array.from({ length: bound + 5 }, (_, i) => ARK(10_000 + i)),
  )
  const client = fakeClient((ark) => ({ ark, ok: false, error: new BnfMcpError("down") }))
  await enrichPendingForProject(project.id, { client })
  assert.equal(client.asked.length, bound, "never more than one bounded pass")
  const untouched = await prisma.bufferItem.count({
    where: { projectId: project.id, enrichStatus: BUFFER_ENRICH_STATUS.PENDING, enrichAttempts: 0 },
  })
  assert.equal(untouched, 5, "the rest waits for the next kick or sweep")
})
