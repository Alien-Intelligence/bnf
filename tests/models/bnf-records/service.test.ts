// tests/models/bnf-records/service.test.ts
// The global BnF record cache. Its guarantees: entries are permanent (no TTL),
// a staged write can never downgrade a complete entry, an undecided OCR verdict
// is never frozen, and a corrupt payload is a miss rather than a crash.
import "server-only"

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { BnfMcpDocumentDetail, BnfMcpResolveResult } from "@/lib/bnf/types"
import { BnfRecordService } from "@/models/bnf-records/service"
import { BNF_RECORD_SOURCE } from "@/models/bnf-records/schema"

const GALLICA = (n: number) => `ark:/12148/bpt6k${String(9_500_000 + n)}`
const NOTICE = (n: number) => `ark:/12148/cb${String(9_500_000 + n)}x`
const arks = new Set<string>()
const track = (ark: string): string => {
  arks.add(ark)
  return ark
}

const record = (ark: string, over: Partial<BnfMcpDocumentDetail> = {}): BnfMcpResolveResult => ({
  ark,
  ok: true,
  document: { ark, title: "Titre", gallica_typedoc: "monographies", ...over },
})

const payloadOf = async (ark: string) => (await prisma.bnfRecord.findUniqueOrThrow({ where: { ark } })).payload as BnfMcpDocumentDetail

after(async () => {
  await prisma.bnfRecord.deleteMany({ where: { ark: { in: [...arks] } } })
})

test("foundAmong returns what is stored, keyed by the ARK as asked, and nothing for a miss", async () => {
  const hit = track(GALLICA(1))
  const miss = track(GALLICA(2))
  await BnfRecordService.upsertMany([record(hit, { ocr_source: "oai", ocr_available: true })])
  const found = await BnfRecordService.foundAmong([hit, miss])
  assert.deepEqual([...found.keys()], [hit])
  assert.equal(found.get(hit)!.title, "Titre")
  assert.deepEqual(await BnfRecordService.foundAmong([]), new Map())
})

test("there is no TTL: an entry fetched long ago is still found", async () => {
  const ark = track(GALLICA(3))
  await BnfRecordService.upsertMany([record(ark, { ocr_source: "oai", ocr_available: true })])
  await prisma.bnfRecord.update({ where: { ark }, data: { fetchedAt: new Date("2020-01-01") } })
  assert.ok((await BnfRecordService.foundAmong([ark])).has(ark))
})

test("upsertMany replaces an entry (the explicit refresh path)", async () => {
  const ark = track(GALLICA(4))
  await BnfRecordService.upsertMany([record(ark, { title: "Ancien", ocr_source: "oai", ocr_available: true })])
  await BnfRecordService.upsertMany([record(ark, { title: "Nouveau", ocr_source: "oai", ocr_available: true })])
  assert.equal((await payloadOf(ark)).title, "Nouveau")
})

test("insertMissing stores a new ARK but never overwrites an existing entry", async () => {
  const complete = track(GALLICA(5))
  const fresh = track(GALLICA(6))
  await BnfRecordService.upsertMany([record(complete, { ocr_source: "manifest", ocr_available: false, pages: 4 })])
  await BnfRecordService.insertMissing([record(complete, { title: "Staged" }), record(fresh, { title: "Staged" })])
  assert.equal((await payloadOf(complete)).ocr_source, "manifest", "a staged write did not downgrade the complete entry")
  assert.equal((await payloadOf(complete)).title, "Titre")
  assert.equal((await payloadOf(fresh)).title, "Staged")
})

test("an undecided OCR verdict is stored as a staged entry: no verdict field survives", async () => {
  const ark = track(GALLICA(7))
  await BnfRecordService.upsertMany([
    record(ark, { ocr_available: null, ocr_source: "manifest", pages: null, pages_source: null, taux_ocr: 0 }),
  ])
  const payload = await payloadOf(ark)
  for (const key of ["ocr_available", "ocr_source", "pages", "pages_source", "taux_ocr"]) {
    assert.ok(!(key in payload), `${key} must not be frozen into the cache`)
  }
  assert.equal(payload.title, "Titre", "the OAI record itself is kept")
  assert.equal(BnfRecordService.needsOcrRule(ark, payload), true)
})

test("a decided verdict (including a negative one) is kept as is", async () => {
  const ark = track(GALLICA(8))
  await BnfRecordService.upsertMany([record(ark, { ocr_available: false, ocr_source: "image_like" })])
  const payload = await payloadOf(ark)
  assert.equal(payload.ocr_available, false)
  assert.equal(BnfRecordService.needsOcrRule(ark, payload), false)
})

test("needsOcrRule: a Gallica record without ocr_source is staged; a catalogue record never is", () => {
  assert.equal(BnfRecordService.needsOcrRule(GALLICA(9), { ark: "x", title: "t" }), true)
  assert.equal(BnfRecordService.needsOcrRule(GALLICA(9), { ark: "x", title: "t", ocr_source: "oai" }), false)
  assert.equal(BnfRecordService.needsOcrRule(NOTICE(9), { ark: "x", title: "t" }), false)
})

test("the source follows the ARK: catalogue notices are catalogue_sru, the rest oai_gallica", async () => {
  const g = track(GALLICA(10))
  const n = track(NOTICE(10))
  await BnfRecordService.upsertMany([record(g, { ocr_source: "oai", ocr_available: true }), record(n, { gallica_typedoc: undefined })])
  assert.equal((await prisma.bnfRecord.findUniqueOrThrow({ where: { ark: g } })).source, BNF_RECORD_SOURCE.OAI_GALLICA)
  assert.equal((await prisma.bnfRecord.findUniqueOrThrow({ where: { ark: n } })).source, BNF_RECORD_SOURCE.CATALOGUE_SRU)
})

test("a corrupt payload is reported and treated as a miss, and the next write repairs it", async () => {
  const ark = track(GALLICA(11))
  await prisma.bnfRecord.create({ data: { ark, payload: ["not", "a", "record"], source: BNF_RECORD_SOURCE.OAI_GALLICA } })
  assert.equal((await BnfRecordService.foundAmong([ark])).size, 0)
  await BnfRecordService.upsertMany([record(ark, { ocr_source: "oai", ocr_available: true })])
  assert.equal((await BnfRecordService.foundAmong([ark])).size, 1)
})
