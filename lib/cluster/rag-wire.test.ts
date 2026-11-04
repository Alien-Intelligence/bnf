// lib/cluster/rag-wire.test.ts
// The mappers between the data-cluster MCP wire shapes and the app's RAG
// shapes, shared by both runners. No network: the cluster payloads are literal.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { datasetIdSchema, entryIdSchema } from "./composite-ids"
import { DataclusterMcpProtocolError } from "./datacluster-mcp-client"
import { RAG_LOOKUP_STATUS } from "./rag"
import { arkLookup, assertInDataset, chunkToPassage, pickLiveEntryId, toEntryContent } from "./rag-wire"
import type { ArkLookup } from "./rag-wire"

const ARK = "ark:/12148/bpt6k822781z"
const DATASET = datasetIdSchema.parse("113:6363")
/** An entry of the test dataset, by its platform entry number. */
const entry = (n: number) => entryIdSchema.parse(`113:6363:${n}`)

test("chunkToPassage returns charRange null when the chunk has no char offsets", () => {
  // Every chunk indexed before worker-v2 wrote offsets looks like this. The
  // honest answer is "unknown", never [0, 0].
  const passage = chunkToPassage({
    entry_id: entry(41),
    dataset_id: DATASET,
    score: 0.8,
    chunk_text: "texte",
    metadata: { ark: ARK, folio: 2 },
  })
  assert.ok(passage)
  assert.equal(passage.charRange, null)
  assert.equal(passage.folio, 2)
  assert.equal(passage.entryId, entry(41), "the entry id is the chunk's top-level composite id")
})

test("chunkToPassage carries the CONTRACT offsets of a page", () => {
  // Folio 9 of the CONTRACT sample in folio-text.test.ts: [39, 76] code points.
  const passage = chunkToPassage({
    entry_id: entry(41),
    dataset_id: DATASET,
    score: 0.8,
    chunk_text: "Le 𝔊 gothique — Œuvre\nsur deux lignes",
    metadata: { ark: ARK, folio: 9, char_start: 39, char_end: 76 },
  })
  assert.ok(passage)
  assert.deepEqual(passage.charRange, [39, 76])
})

test("chunkToPassage refuses an offset pair that is not a range", () => {
  const chunk = (char_start: number | undefined, char_end: number | undefined) => ({
    entry_id: entry(41),
    dataset_id: DATASET,
    score: 0.8,
    chunk_text: "texte",
    metadata: { ark: ARK, folio: 2, char_start, char_end },
  })
  assert.throws(() => chunkToPassage(chunk(17, 12)), DataclusterMcpProtocolError)
  assert.throws(() => chunkToPassage(chunk(-1, 4)), DataclusterMcpProtocolError)
  assert.throws(() => chunkToPassage(chunk(3, undefined)), DataclusterMcpProtocolError)
  assert.throws(() => chunkToPassage(chunk(1.5, 4)), DataclusterMcpProtocolError)
})

test("chunkToPassage drops a chunk with no ARK", () => {
  assert.equal(
    chunkToPassage({ entry_id: entry(41), dataset_id: DATASET, score: 1, chunk_text: "x", metadata: { folio: 1 } }),
    null,
  )
})

test("toEntryContent: full mode (no pagination fields) is the whole document, in code points", () => {
  // mcp-datacluster returns the raw stored payload in full mode (char_limit 0,
  // char_offset 0): only `text`, none of the pagination fields.
  const out = toEntryContent({ text: "ab😀d" }, { entryId: entry(7), charOffset: 0, charLimit: 0 })
  assert.deepEqual(out, {
    entryId: entry(7),
    text: "ab😀d",
    charOffset: 0,
    charLimit: 0,
    totalLength: 4,
    hasMore: false,
    nextOffset: 4,
  })
})

test("toEntryContent: paginated mode passes the fields through and resolves a null next_offset", () => {
  // Last page of a paginated read: has_more false, next_offset null on the wire.
  const out = toEntryContent(
    {
      entry_id: entry(7),
      text: "ef",
      char_offset: 4,
      char_limit: 4,
      total_length: 6,
      has_more: false,
      next_offset: null,
    },
    { entryId: entry(7), charOffset: 4, charLimit: 4 },
  )
  assert.deepEqual(out, {
    entryId: entry(7),
    text: "ef",
    charOffset: 4,
    charLimit: 4,
    totalLength: 6,
    hasMore: false,
    nextOffset: 6,
  })
})

test("toEntryContent: a paginated reply missing a pagination field is a protocol error, not 'end of document'", () => {
  assert.throws(
    () =>
      toEntryContent(
        { text: "abcd", char_offset: 0, char_limit: 4, total_length: 90 },
        { entryId: entry(7), charOffset: 0, charLimit: 4 },
      ),
    (err: unknown) =>
      err instanceof DataclusterMcpProtocolError && /has_more, next_offset/.test(err.message),
  )
})

test("toEntryContent: offset-only mode needs char_offset, total_length and has_more", () => {
  const out = toEntryContent(
    { text: "cdef", char_offset: 2, total_length: 6, has_more: false },
    { entryId: entry(7), charOffset: 2, charLimit: 0 },
  )
  assert.equal(out.charOffset, 2)
  assert.equal(out.charLimit, 0)
  assert.equal(out.nextOffset, 6)
  assert.throws(
    () => toEntryContent({ text: "cdef" }, { entryId: entry(7), charOffset: 2, charLimit: 0 }),
    DataclusterMcpProtocolError,
  )
})

/** A keyword hit of the ARK lookup, created at `createdAt`. */
const hit = (n: number, createdAt: string | undefined, over: Record<string, unknown> = {}) => ({
  entry_id: entry(n),
  dataset_id: DATASET,
  metadata: { ark: ARK, created_at: createdAt },
  ...over,
})
const OLD = "2026-11-01T10:00:00.000000+00:00"
const NEW = "2026-11-04T16:44:28.162573+00:00"
const complete = (hits: ReturnType<typeof hit>[]) => arkLookup(hits, { total: hits.length, unaddressable: 0 }, ARK, DATASET)

function entriesOf(lookup: ArkLookup) {
  assert.equal(lookup.status, RAG_LOOKUP_STATUS.FOUND, JSON.stringify(lookup))
  if (lookup.status !== RAG_LOOKUP_STATUS.FOUND) throw new Error("unreachable after the assertion")
  return lookup.entries
}

test("pickLiveEntryId takes the most recently CREATED entry, whatever its entry number", () => {
  // The platform entry number follows the backend's version order, not the
  // cluster's creation order: the NEW entry may carry the LOWER number.
  const entries = entriesOf(complete([hit(900, OLD), hit(12, NEW), hit(40, OLD)]))
  assert.deepEqual(entries.map((e) => e.entryId), [entry(900), entry(12), entry(40)])
  assert.equal(pickLiveEntryId(entries), entry(12))
  assert.equal(pickLiveEntryId(entriesOf(complete([]))), null)
})

test("pickLiveEntryId breaks a creation-time tie by entry NUMBER, numerically (9 < 10 < 100)", () => {
  assert.equal(pickLiveEntryId(entriesOf(complete([hit(9, NEW), hit(100, NEW), hit(10, NEW)]))), entry(100))
  assert.equal(pickLiveEntryId(entriesOf(complete([hit(9_195_584, NEW), hit(9_195_583, NEW)]))), entry(9_195_584))
})

test("arkLookup refuses a hit of another ARK or one without an ARK", () => {
  assert.throws(
    () => complete([hit(3, NEW, { metadata: { ark: "ark:/12148/bpt6k0000000", created_at: NEW } })]),
    DataclusterMcpProtocolError,
  )
  assert.throws(() => complete([hit(3, NEW, { metadata: undefined })]), DataclusterMcpProtocolError)
})

test("arkLookup refuses a hit with no created_at or one that is not an ISO datetime — the live entry cannot be told", () => {
  for (const createdAt of [undefined, "", "yesterday", "2026-11-04", 1_793_800_000]) {
    assert.throws(
      () => complete([hit(3, createdAt as string | undefined)]),
      (err: unknown) => err instanceof DataclusterMcpProtocolError && /no valid created_at/.test(err.message),
      String(createdAt),
    )
  }
})

test("arkLookup refuses a hit of another dataset: a cross-project entry is never offered as the ARK's", () => {
  const foreign = hit(3, NEW, { dataset_id: datasetIdSchema.parse("113:6352"), entry_id: entryIdSchema.parse("113:6352:3") })
  assert.throws(
    () => complete([hit(12, NEW), foreign]),
    (err: unknown) => err instanceof DataclusterMcpProtocolError && /outside the project's dataset 113:6363/.test(err.message),
  )
})

test("arkLookup says REINDEXING, not error, when the pages do not add up (a re-ingest in flight)", () => {
  const one = hit(12, NEW)
  const expectReindexing = (lookup: ArkLookup, why: RegExp) => {
    assert.equal(lookup.status, RAG_LOOKUP_STATUS.ENTRY_REINDEXING)
    assert.ok(lookup.status === RAG_LOOKUP_STATUS.ENTRY_REINDEXING && why.test(lookup.reason), JSON.stringify(lookup))
  }
  expectReindexing(arkLookup([one], { total: 6, unaddressable: 0 }, ARK, DATASET), /counted 6 entries but its pages held 1/)
  expectReindexing(arkLookup([one], { total: 2, unaddressable: 1 }, ARK, DATASET), /1 match\(es\) have no addressable entry id/)
  expectReindexing(arkLookup([one, one], { total: 2, unaddressable: 0 }, ARK, DATASET), /same entry came back twice/)
})

test("arkLookup refuses a lookup with no total: nothing says the set is complete", () => {
  assert.throws(() => arkLookup([hit(12, NEW)], { total: undefined, unaddressable: undefined }, ARK, DATASET), /no pagination.total/)
})

test("assertInDataset passes the project's own hits and names the first foreign one", () => {
  const own = { entry_id: entry(1), dataset_id: DATASET }
  assertInDataset([own, own], DATASET, "tool")
  assertInDataset([], DATASET, "tool")
  const foreign = { entry_id: entryIdSchema.parse("113:766:2038356"), dataset_id: datasetIdSchema.parse("113:766") }
  assert.throws(
    () => assertInDataset([own, foreign], DATASET, "datacluster_keyword_search"),
    /datacluster_keyword_search returned entry 113:766:2038356 of dataset 113:766, outside the project's dataset 113:6363/,
  )
})

test("toEntryContent: a paginated reply that contradicts itself or the request is a protocol error", () => {
  const req = { entryId: entry(7), charOffset: 0, charLimit: 4 }
  const page = { entry_id: entry(7), text: "abcd", char_offset: 0, char_limit: 4, total_length: 9, has_more: true, next_offset: 4 }
  assert.equal(toEntryContent(page, req).nextOffset, 4, "a consistent page passes")
  for (const bad of [
    { ...page, next_offset: 5 },
    { ...page, has_more: false },
    { ...page, has_more: true, next_offset: null },
    { ...page, char_offset: 2 },
    { ...page, char_limit: 8 },
  ]) {
    assert.throws(() => toEntryContent(bad, req), /inconsistent pagination/, JSON.stringify(bad))
  }
})

test("toEntryContent: an offset-only reply must echo the offset and have nothing more", () => {
  const req = { entryId: entry(7), charOffset: 2, charLimit: 0 }
  assert.throws(() => toEntryContent({ text: "cdef", char_offset: 3, total_length: 6, has_more: false }, req), /inconsistent/)
  assert.throws(() => toEntryContent({ text: "cdef", char_offset: 2, total_length: 6, has_more: true }, req), /inconsistent/)
})

test("chunkToPassage refuses a folio that is not a positive integer", () => {
  const chunk = (folio: number) => ({
    entry_id: entry(4),
    dataset_id: DATASET,
    score: 1,
    chunk_text: "x",
    metadata: { ark: ARK, folio },
  })
  assert.throws(() => chunkToPassage(chunk(0)), /invalid folio/)
  assert.throws(() => chunkToPassage(chunk(-2)), /invalid folio/)
  assert.equal(chunkToPassage(chunk(3))?.folio, 3)
})

test("toEntryContent: a page must fit the document — length, total, has_more and the echoed entry id", () => {
  const req = { entryId: entry(7), charOffset: 0, charLimit: 4 }
  const page = { entry_id: entry(7), text: "abcd", char_offset: 0, char_limit: 4, total_length: 9, has_more: true, next_offset: 4 }
  for (const bad of [
    // the reviewer's probe: short text, a large total, no more, another entry
    { entry_id: entry(99), text: "0123456789", char_offset: 0, char_limit: 4, total_length: 9000, has_more: false, next_offset: null },
    { ...page, entry_id: entry(99) },
    { ...page, text: "abcdef", next_offset: 6 },
    { ...page, total_length: 3 },
    { ...page, total_length: 4, has_more: true },
    { ...page, entry_id: undefined },
  ]) {
    assert.throws(() => toEntryContent(bad, req), /inconsistent|omitted/, JSON.stringify(bad))
  }
  // Past the end: an empty slice and nothing more is consistent.
  const past = toEntryContent(
    { entry_id: entry(7), text: "", char_offset: 20, char_limit: 4, total_length: 9, has_more: false, next_offset: null },
    { entryId: entry(7), charOffset: 20, charLimit: 4 },
  )
  assert.equal(past.text, "")
})

test("toEntryContent: an offset-only slice must run to the end of the document", () => {
  const req = { entryId: entry(7), charOffset: 2, charLimit: 0 }
  assert.equal(toEntryContent({ text: "cdef", char_offset: 2, total_length: 6, has_more: false }, req).nextOffset, 6)
  assert.throws(() => toEntryContent({ text: "cd", char_offset: 2, total_length: 6, has_more: false }, req), /inconsistent/)
  assert.throws(
    () => toEntryContent({ entry_id: entry(8), text: "cdef", char_offset: 2, total_length: 6, has_more: false }, req),
    /inconsistent/,
  )
})
