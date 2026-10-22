// tests/models/documents/resolver.test.ts
// The background metadata resolver (lib/documents/resolver.ts): the global BnF
// record cache in front of BnF, the drain's wall-clock ceiling, and the retry
// policy. The client is injected and records every call, so "zero BnF calls" is
// asserted against a fake that provably works (a negative result can never come
// from a dead fake). Runs against the real Postgres; each test owns a fresh
// project and a private ARK range.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import {
  OCR_SOURCE,
  PAGES_SOURCE,
  RESOLVE_MODE,
  type BnfMcpDocumentDetail,
  type BnfMcpResolveError,
  type BnfMcpResolveResult,
} from "@/lib/bnf/types"
import { RESOLVE_MAX_ATTEMPTS, RESOLVE_RETRY_BASE_MS, RESOLVE_RETRY_CAP_MS } from "@/lib/constants"
import {
  resolvePendingForProject,
  resumePendingResolves,
  type CommitResolveOptions,
  type DocumentResolveClient,
} from "@/lib/documents/resolver"
import { BnfMcpError, BnfMcpNotFoundError, BnfMcpRateLimitError } from "@/lib/mcp/errors"
import { BnfRecordService } from "@/models/bnf-records/service"
import { DocumentService } from "@/models/documents/service"
import { DOCUMENT_CANONICAL_STATUS, DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"
import { createTestUser, createTestProject, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"

let user: User
const projects: string[] = []
const usedArks = new Set<string>()

/** Fixed synthetic ARKs, one per test slot: the ARK stays an opaque literal, never built from an id. */
const SYNTHETIC_ARKS: Readonly<Record<number, string>> = {
  1: "ark:/12148/bpt6k9400001",
  2: "ark:/12148/bpt6k9400002",
  3: "ark:/12148/bpt6k9400003",
  4: "ark:/12148/bpt6k9400004",
  5: "ark:/12148/bpt6k9400005",
  6: "ark:/12148/bpt6k9400006",
  7: "ark:/12148/bpt6k9400007",
  10: "ark:/12148/bpt6k9400010",
  11: "ark:/12148/bpt6k9400011",
  12: "ark:/12148/bpt6k9400012",
  13: "ark:/12148/bpt6k9400013",
  20: "ark:/12148/bpt6k9400020",
  21: "ark:/12148/bpt6k9400021",
  22: "ark:/12148/bpt6k9400022",
  23: "ark:/12148/bpt6k9400023",
  24: "ark:/12148/bpt6k9400024",
  25: "ark:/12148/bpt6k9400025",
  26: "ark:/12148/bpt6k9400026",
  30: "ark:/12148/bpt6k9400030",
  31: "ark:/12148/bpt6k9400031",
}

const ARK = (slot: number): string => {
  const ark = SYNTHETIC_ARKS[slot]
  if (ark === undefined) throw new Error(`no synthetic ARK for test slot ${slot}`)
  usedArks.add(ark)
  return ark
}

const shortArk = (ark: string): string => ark.replace("ark:/12148/", "")

/** A complete Gallica record: the OCR rule ran (`ocr_source` set). */
function completeDetail(ark: string, over: Partial<BnfMcpDocumentDetail> = {}): BnfMcpDocumentDetail {
  return {
    ark: shortArk(ark),
    title: `Titre ${shortArk(ark)}`,
    date: "1937",
    doc_type: "texte",
    language: "fre",
    gallica_typedoc: "monographies",
    ocr_available: true,
    ocr_source: OCR_SOURCE.OAI,
    ...over,
  }
}

/** A counting fake: answers from `respond`, records every call it receives. */
type Call = { arks: string[]; opts: CommitResolveOptions }
function fake(respond: (ark: string) => BnfMcpResolveResult | BnfMcpResolveError): {
  factory: () => DocumentResolveClient
  calls: Call[]
} {
  const calls: Call[] = []
  return {
    calls,
    factory: () => ({
      async resolveArks(arks, opts) {
        calls.push({ arks: [...arks], opts })
        return arks.map(respond)
      },
    }),
  }
}

const ok = (ark: string, over?: Partial<BnfMcpDocumentDetail>): BnfMcpResolveResult => ({
  ark,
  ok: true,
  document: completeDetail(ark, over),
})
const ko = (ark: string, error: unknown): BnfMcpResolveError => ({ ark, ok: false, error })

async function freshProject(label: string, arks: string[]): Promise<Project> {
  const p = await createTestProject(user.id, label)
  projects.push(p.id)
  await DocumentService.createStubs(p.id, arks)
  return p
}

async function doc(projectId: string, ark: string) {
  return prisma.document.findUniqueOrThrow({ where: { projectId_ark: { projectId, ark } } })
}

async function cacheEntry(ark: string) {
  return prisma.bnfRecord.findUnique({ where: { ark } })
}

before(async () => {
  user = await createTestUser()
})

after(async () => {
  for (const id of projects) await cleanupProject(id)
  await prisma.bnfRecord.deleteMany({ where: { ark: { in: [...usedArks] } } })
  await deleteTestUser(user.id)
})

// --- the cache --------------------------------------------------------------

test("a cache miss asks the client once (commit mode, nothing staged) and stores the record", async () => {
  const a = ARK(1)
  const project = await freshProject("resolver-miss", [a])
  const { factory, calls } = fake((ark) => ok(ark))
  await resolvePendingForProject(project.id, { client: factory })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.arks, [a])
  assert.deepEqual(calls[0]!.opts, { mode: RESOLVE_MODE.COMMIT })
  const d = await doc(project.id, a)
  assert.equal(d.resolveStatus, DOCUMENT_RESOLVE_STATUS.RESOLVED)
  assert.equal(d.title, `Titre ${shortArk(a)}`)
  const entry = await cacheEntry(a)
  assert.ok(entry, "the fresh record is in the cache")
  assert.equal(entry.source, "oai_gallica")
  assert.equal((entry.payload as BnfMcpDocumentDetail).ocr_source, OCR_SOURCE.OAI)
})

test("a cache hit resolves the row with ZERO client calls", async () => {
  const a = ARK(2)
  await BnfRecordService.upsertMany([ok(a)])
  const project = await freshProject("resolver-hit", [a])
  const { factory, calls } = fake(() => {
    throw new Error("a cache hit must not call BnF")
  })
  await resolvePendingForProject(project.id, { client: factory })
  assert.deepEqual(calls, [])
  const d = await doc(project.id, a)
  assert.equal(d.resolveStatus, DOCUMENT_RESOLVE_STATUS.RESOLVED)
  assert.equal(d.title, `Titre ${shortArk(a)}`)
})

test("normalization runs on read: a cached record is normalized afresh, not stored normalized", async () => {
  const a = ARK(3)
  await BnfRecordService.upsertMany([ok(a, { date: "1937-07-12" })])
  const stored = (await cacheEntry(a))!.payload as BnfMcpDocumentDetail
  assert.equal(stored.date, "1937-07-12", "the payload is the raw record")
  assert.equal(stored.docType, undefined, "no normalized field leaks into the cache")
  const project = await freshProject("resolver-normalize", [a])
  await resolvePendingForProject(project.id, { client: fake(() => ok(a)).factory })
  assert.equal((await doc(project.id, a)).year, 1937)
})

test("a STAGED entry (no ocr_source) goes to the client as `staged`: only the OCR rule runs, and the entry is completed", async () => {
  const a = ARK(4)
  const stagedRecord = completeDetail(a, { ocr_available: undefined, ocr_source: undefined })
  await BnfRecordService.insertMissing([{ ark: a, ok: true, document: stagedRecord }])
  assert.equal(BnfRecordService.needsOcrRule(a, (await cacheEntry(a))!.payload as BnfMcpDocumentDetail), true)
  const project = await freshProject("resolver-staged", [a])
  const { factory, calls } = fake((ark) => ok(ark, { ocr_available: false, ocr_source: OCR_SOURCE.MANIFEST, pages: 4, pages_source: PAGES_SOURCE.MANIFEST }))
  await resolvePendingForProject(project.id, { client: factory })
  assert.equal(calls.length, 1)
  assert.deepEqual([...calls[0]!.opts.staged!.keys()], [a], "the cached OAI record rides along: no OAI re-fetch")
  assert.equal(calls[0]!.opts.staged!.get(a)!.title, stagedRecord.title)
  const d = await doc(project.id, a)
  assert.equal(d.ocrAvailable, false)
  assert.equal(d.pages, 4)
  assert.equal(((await cacheEntry(a))!.payload as BnfMcpDocumentDetail).ocr_source, OCR_SOURCE.MANIFEST, "completed for every later reader")
})

test("a record whose OCR verdict is undecided is cached as STAGED, never frozen", async () => {
  const a = ARK(5)
  const project = await freshProject("resolver-undecided", [a])
  const { factory } = fake((ark) => ok(ark, { ocr_available: null, ocr_source: OCR_SOURCE.MANIFEST, pages: null, pages_source: null }))
  await resolvePendingForProject(project.id, { client: factory })
  assert.equal((await doc(project.id, a)).resolveStatus, DOCUMENT_RESOLVE_STATUS.RESOLVED)
  const payload = (await cacheEntry(a))!.payload as BnfMcpDocumentDetail
  assert.equal(payload.ocr_source, undefined)
  assert.equal(BnfRecordService.needsOcrRule(a, payload), true, "the next commit-time resolve re-runs the OCR rule")
})

test("a record normalize drops (no title) is not cached and counts as an ordinary failed attempt", async () => {
  const a = ARK(6)
  const project = await freshProject("resolver-untitled", [a])
  await resolvePendingForProject(project.id, { client: fake((ark) => ok(ark, { title: undefined })).factory })
  assert.equal(await cacheEntry(a), null)
  const d = await doc(project.id, a)
  assert.equal(d.resolveAttempts, 1)
  assert.match(d.resolveError ?? "", /incomplètes/)
})

test("project B resolves an ARK project A holds with ZERO client calls, and carries none of A's state", async () => {
  const a = ARK(7)
  const projectA = await freshProject("resolver-cross-a", [a])
  await resolvePendingForProject(projectA.id, { client: fake((ark) => ok(ark)).factory })
  // A's own state: indexed, with an error note and a canonical verdict.
  await prisma.document.update({
    where: { projectId_ark: { projectId: projectA.id, ark: a } },
    data: { indexedAt: new Date(), indexError: "boom", canonicalStatus: DOCUMENT_CANONICAL_STATUS.API_ERROR },
  })

  const projectB = await freshProject("resolver-cross-b", [a])
  const { factory, calls } = fake(() => {
    throw new Error("project B must read the cache")
  })
  await resolvePendingForProject(projectB.id, { client: factory })
  assert.deepEqual(calls, [])
  const b = await doc(projectB.id, a)
  assert.equal(b.resolveStatus, DOCUMENT_RESOLVE_STATUS.RESOLVED)
  assert.equal(b.title, `Titre ${shortArk(a)}`)
  assert.equal(b.indexedAt, null)
  assert.equal(b.indexError, null)
  assert.equal(b.canonicalStatus, null)
})

// --- the drain's ceiling ----------------------------------------------------

test("a drain stops at its wall-clock ceiling: the row stays pending, no attempt is spent", async () => {
  const a = ARK(10)
  const project = await freshProject("resolver-ceiling", [a])
  const hangs = (signal: AbortSignal): DocumentResolveClient => ({
    resolveArks: () =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      }),
  })
  await resolvePendingForProject(project.id, { client: hangs, maxDrainMs: 20 })
  const d = await doc(project.id, a)
  assert.equal(d.resolveAttempts, 0, "our own ceiling is not a BnF failure")
  assert.equal(d.resolveStatus, DOCUMENT_RESOLVE_STATUS.PENDING)
  assert.equal(d.nextResolveAt, null, "no backoff: the next pass retakes it")
  assert.match(d.resolveError ?? "", /délai/)
})

test("the ceiling covers the whole drain: a rerun requested meanwhile does not restart the clock", async () => {
  const a = ARK(11)
  const project = await freshProject("resolver-ceiling-rerun", [a])
  let passes = 0
  const slow = (signal: AbortSignal): DocumentResolveClient => ({
    resolveArks: () => {
      passes++
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        // Ask for a rerun while the first pass is in flight.
        void resolvePendingForProject(project.id)
      })
    },
  })
  const started = Date.now()
  await resolvePendingForProject(project.id, { client: slow, maxDrainMs: 30 })
  assert.equal(passes, 1, "the aborted drain does not loop into a rerun")
  assert.ok(Date.now() - started < 5_000)
})

test("a cache hit in a batch the ceiling cut short still resolves", async () => {
  const hit = ARK(12)
  const miss = ARK(13)
  await BnfRecordService.upsertMany([ok(hit)])
  const project = await freshProject("resolver-ceiling-hit", [hit, miss])
  const hangs = (signal: AbortSignal): DocumentResolveClient => ({
    resolveArks: () =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      }),
  })
  await resolvePendingForProject(project.id, { client: hangs, maxDrainMs: 20 })
  assert.equal((await doc(project.id, hit)).resolveStatus, DOCUMENT_RESOLVE_STATUS.RESOLVED)
  const m = await doc(project.id, miss)
  assert.equal(m.resolveStatus, DOCUMENT_RESOLVE_STATUS.PENDING)
  assert.equal(m.resolveAttempts, 0)
})

// --- retry policy -----------------------------------------------------------

test("a transient failure counts an attempt and backs off exponentially; a row in backoff is not retried", async () => {
  const a = ARK(20)
  const project = await freshProject("resolver-backoff", [a])
  const t0 = Date.now()
  const clock = { t: t0 }
  const now = () => new Date(clock.t)
  const { factory, calls } = fake((ark) => ko(ark, new BnfMcpError("BnF down")))

  await resolvePendingForProject(project.id, { client: factory, now })
  let d = await doc(project.id, a)
  assert.equal(d.resolveAttempts, 1)
  assert.equal(d.nextResolveAt?.getTime(), t0 + RESOLVE_RETRY_BASE_MS)

  await resolvePendingForProject(project.id, { client: factory, now })
  assert.equal(calls.length, 1, "not retried within the backoff")

  clock.t = t0 + RESOLVE_RETRY_BASE_MS
  await resolvePendingForProject(project.id, { client: factory, now })
  d = await doc(project.id, a)
  assert.equal(calls.length, 2, "retried once it elapsed")
  assert.equal(d.resolveAttempts, 2)
  assert.equal(d.nextResolveAt?.getTime(), clock.t + 2 * RESOLVE_RETRY_BASE_MS, "the delay doubles")
})

test("the backoff never exceeds its cap", async () => {
  const a = ARK(21)
  const project = await freshProject("resolver-backoff-cap", [a])
  await prisma.document.update({
    where: { projectId_ark: { projectId: project.id, ark: a } },
    data: { resolveAttempts: RESOLVE_MAX_ATTEMPTS - 2 },
  })
  const t0 = Date.now()
  await resolvePendingForProject(project.id, {
    client: fake((ark) => ko(ark, new BnfMcpError("BnF down"))).factory,
    now: () => new Date(t0),
  })
  const d = await doc(project.id, a)
  assert.equal(d.resolveAttempts, RESOLVE_MAX_ATTEMPTS - 1)
  assert.ok(d.nextResolveAt!.getTime() - t0 <= RESOLVE_RETRY_CAP_MS)
})

test("the last attempt fails the row for good", async () => {
  const a = ARK(22)
  const project = await freshProject("resolver-last-attempt", [a])
  await prisma.document.update({
    where: { projectId_ark: { projectId: project.id, ark: a } },
    data: { resolveAttempts: RESOLVE_MAX_ATTEMPTS - 1 },
  })
  await resolvePendingForProject(project.id, { client: fake((ark) => ko(ark, new BnfMcpError("BnF down"))).factory })
  const d = await doc(project.id, a)
  assert.equal(d.resolveStatus, DOCUMENT_RESOLVE_STATUS.FAILED)
  assert.equal(d.nextResolveAt, null)
})

test("a BnF 404 is terminal on the first occurrence", async () => {
  const a = ARK(23)
  const project = await freshProject("resolver-not-found", [a])
  await resolvePendingForProject(project.id, { client: fake((ark) => ko(ark, new BnfMcpNotFoundError("BnF HTTP 404"))).factory })
  const d = await doc(project.id, a)
  assert.equal(d.resolveStatus, DOCUMENT_RESOLVE_STATUS.FAILED)
  assert.equal(d.resolveAttempts, 1)
  assert.match(d.resolveError ?? "", /404/)
})

test("a 429 spends no attempt and honours Retry-After", async () => {
  const a = ARK(24)
  const project = await freshProject("resolver-rate-limit", [a])
  const t0 = Date.now()
  await resolvePendingForProject(project.id, {
    client: fake((ark) => ko(ark, new BnfMcpRateLimitError("slow down", 90_000))).factory,
    now: () => new Date(t0),
  })
  const d = await doc(project.id, a)
  assert.equal(d.resolveAttempts, 0)
  assert.equal(d.resolveStatus, DOCUMENT_RESOLVE_STATUS.PENDING)
  assert.equal(d.nextResolveAt?.getTime(), t0 + 90_000)
})

test("a 429 without Retry-After backs off by the base delay; an absurd Retry-After is capped", async () => {
  const bare = ARK(25)
  const absurd = ARK(26)
  const project = await freshProject("resolver-rate-limit-bounds", [bare, absurd])
  const t0 = Date.now()
  await resolvePendingForProject(project.id, {
    client: fake((ark) =>
      ko(ark, new BnfMcpRateLimitError("slow down", ark === absurd ? 10 * RESOLVE_RETRY_CAP_MS : undefined)),
    ).factory,
    now: () => new Date(t0),
  })
  assert.equal((await doc(project.id, bare)).nextResolveAt?.getTime(), t0 + RESOLVE_RETRY_BASE_MS)
  assert.equal((await doc(project.id, absurd)).nextResolveAt?.getTime(), t0 + RESOLVE_RETRY_CAP_MS)
})

// --- the sweep ----------------------------------------------------------------

test("the sweep never overlaps itself: a second call while one runs returns at once", async () => {
  const a = ARK(30)
  const project = await freshProject("resolver-sweep", [a])
  let entered!: () => void
  const inFlight = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let sweepCalls = 0
  // The sweep scans every project, so the fake only touches ARKs it was asked
  // about and answers each as a ceiling cut (no attempt is spent anywhere).
  const blocked = (): DocumentResolveClient => ({
    async resolveArks(arks) {
      sweepCalls++
      entered()
      await gate
      return arks.map((ark) => ko(ark, Object.assign(new Error("test: sweep released"), { name: "AbortError" })))
    },
  })

  const first = resumePendingResolves({ client: blocked })
  await inFlight
  const startedAt = Date.now()
  await resumePendingResolves({ client: blocked }) // returns without waiting for `first`
  assert.ok(Date.now() - startedAt < 1_000)
  assert.equal(sweepCalls, 1, "the overlapping sweep did not start a second drain")
  release()
  await first
  assert.equal((await doc(project.id, a)).resolveAttempts, 0)
})

test("the sweep skips rows still in backoff", async () => {
  const a = ARK(31)
  const project = await freshProject("resolver-sweep-backoff", [a])
  await prisma.document.update({
    where: { projectId_ark: { projectId: project.id, ark: a } },
    data: { nextResolveAt: new Date(Date.now() + 60 * 60 * 1_000) },
  })
  const asked: string[] = []
  const recorder = (): DocumentResolveClient => ({
    async resolveArks(arks) {
      asked.push(...arks)
      return arks.map((ark) => ko(ark, Object.assign(new Error("test: not a failure"), { name: "AbortError" })))
    },
  })
  await resumePendingResolves({ client: recorder })
  assert.ok(!asked.includes(a), "a row in backoff is not due")
})
