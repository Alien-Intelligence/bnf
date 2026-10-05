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
import {
  BUFFER_ENRICH_BATCH_SIZE,
  BUFFER_ENRICH_DRAIN_MAX_BATCHES,
  BUFFER_ENRICH_MAX_ATTEMPTS,
  BUFFER_ENRICH_RETRY_BASE_MS,
} from "@/lib/constants"
import { enrichPendingForProject, type BufferEnrichClient } from "@/lib/buffer/enricher"
import { BnfMcpError, BnfMcpNotFoundError } from "@/lib/mcp/errors"
import { BufferService } from "@/models/buffer/service"
import { BUFFER_ENRICH_STATUS } from "@/models/buffer/schema"
import { createTestUser, createTestProject, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"

let user: User
const projects: string[] = []

/** The drain's clock: tests move it past a row's backoff explicitly. */
const clock = {
  t: Date.now(),
  now: (): Date => new Date(clock.t),
  /** Past any backoff the drain could have set. */
  skipBackoff: (): void => {
    clock.t += BUFFER_ENRICH_RETRY_BASE_MS * 2 ** BUFFER_ENRICH_MAX_ATTEMPTS
  },
}

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
  await enrichPendingForProject(project.id, { client: () => client, now: clock.now })
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
  await enrichPendingForProject(project.id, { client: () => client, now: clock.now })
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
    clock.skipBackoff()
    await enrichPendingForProject(project.id, { client: () => client, now: clock.now })
    const r = await row(project.id, ARK(3))
    assert.equal(r.enrichAttempts, attempt)
    assert.equal(
      r.enrichStatus,
      attempt < BUFFER_ENRICH_MAX_ATTEMPTS ? BUFFER_ENRICH_STATUS.PENDING : BUFFER_ENRICH_STATUS.FAILED,
    )
    assert.match(r.enrichError ?? "", /broker 503/)
  }
  // A failed row is never picked up again.
  clock.skipBackoff()
  await enrichPendingForProject(project.id, { client: () => client, now: clock.now })
  assert.equal(client.asked.length, BUFFER_ENRICH_MAX_ATTEMPTS)
})

test("an ARK the BnF does not know is failed at once", async () => {
  const project = await freshProject("enrich-notfound")
  await stageBare(project.id, [ARK(4)])
  const client = fakeClient((ark) => ({ ark, ok: false, error: new BnfMcpNotFoundError("no record") }))
  await enrichPendingForProject(project.id, { client: () => client, now: clock.now })
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
  await enrichPendingForProject(project.id, { client: () => client, now: clock.now })
  assert.equal(client.asked.length, bound, "never more than one bounded pass")
  const untouched = await prisma.bufferItem.count({
    where: { projectId: project.id, enrichStatus: BUFFER_ENRICH_STATUS.PENDING, enrichAttempts: 0 },
  })
  assert.equal(untouched, 5, "the rest waits for the next kick or sweep")
})

test("a failed row waits out its backoff before the next attempt", async () => {
  const project = await freshProject("enrich-backoff")
  await stageBare(project.id, [ARK(5)])
  const client = fakeClient((ark) => ({ ark, ok: false, error: new BnfMcpError("broker 429") }))
  await enrichPendingForProject(project.id, { client: () => client, now: clock.now })
  const first = await row(project.id, ARK(5))
  assert.ok(first.enrichNextAttemptAt !== null && first.enrichNextAttemptAt > clock.now(), "a backoff is persisted")
  await enrichPendingForProject(project.id, { client: () => client, now: clock.now })
  assert.equal(client.asked.length, 1, "not retried within the backoff")
  clock.skipBackoff()
  await enrichPendingForProject(project.id, { client: () => client, now: clock.now })
  assert.equal(client.asked.length, 2, "retried once it elapsed")
})

test("a whole batch that throws is persisted on every row, not lost", async () => {
  const project = await freshProject("enrich-batch-fail")
  await stageBare(project.id, [ARK(6), ARK(7)])
  const throwing: BufferEnrichClient = {
    async resolveArksForStaging() {
      throw new BnfMcpError("broker unreachable")
    },
  }
  await enrichPendingForProject(project.id, { client: () => throwing, now: clock.now })
  for (const ark of [ARK(6), ARK(7)]) {
    const r = await row(project.id, ark)
    assert.equal(r.enrichAttempts, 1)
    assert.match(r.enrichError ?? "", /broker unreachable/)
    assert.equal(r.enrichStatus, BUFFER_ENRICH_STATUS.PENDING)
  }
})

test("a row cleared mid-drain is skipped, and the rest of the batch is still written", async () => {
  const project = await freshProject("enrich-cleared")
  await stageBare(project.id, [ARK(8), ARK(9)])
  const detail = (ark: string): BnfMcpDocumentDetail => ({ ark: ark.replace("ark:/12148/", ""), title: "Titre", doc_type: "texte" })
  const client: BufferEnrichClient = {
    async resolveArksForStaging(arks: string[]) {
      await BufferService.clear(project.id) // the librarian clears while the broker answers
      await stageBare(project.id, [ARK(9)]) // and ARK(9) is staged again
      return arks.map((ark) => ({ ark, ok: true as const, document: detail(ark) }))
    },
  }
  await enrichPendingForProject(project.id, { client: () => client, now: clock.now })
  assert.equal(await prisma.bufferItem.count({ where: { projectId: project.id, ark: ARK(8) } }), 0)
  assert.equal((await row(project.id, ARK(9))).title, "Titre", "the drain did not abort on the missing row")
})

test("a drain stops at its wall-clock ceiling WITHOUT charging the rows an attempt", async () => {
  const project = await freshProject("enrich-ceiling")
  await stageBare(project.id, [ARK(11)])
  const hangs = (signal: AbortSignal): BufferEnrichClient => ({
    resolveArksForStaging: () =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new BnfMcpError("aborted")), { once: true })
      }),
  })
  await enrichPendingForProject(project.id, { client: hangs, now: clock.now, maxDrainMs: 20 })
  const r = await row(project.id, ARK(11))
  assert.equal(r.enrichAttempts, 0, "our own ceiling is not a BnF failure")
  assert.equal(r.enrichStatus, BUFFER_ENRICH_STATUS.PENDING)
  assert.equal(r.enrichNextAttemptAt, null, "no backoff: the next pass retakes it")
  assert.match(r.enrichError ?? "", /délai/)
})

test("per-ARK errors that land after the ceiling fired are not attempts either", async () => {
  const project = await freshProject("enrich-ceiling-per-ark")
  await stageBare(project.id, [ARK(12)])
  const answersLate = (signal: AbortSignal): BufferEnrichClient => ({
    resolveArksForStaging: (arks) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => resolve(arks.map((ark) => ({ ok: false as const, ark, error: new BnfMcpError("aborted") }))),
          { once: true },
        )
      }),
  })
  await enrichPendingForProject(project.id, { client: answersLate, now: clock.now, maxDrainMs: 20 })
  const r = await row(project.id, ARK(12))
  assert.equal(r.enrichAttempts, 0)
  assert.equal(r.enrichStatus, BUFFER_ENRICH_STATUS.PENDING)
})
