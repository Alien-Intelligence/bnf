// lib/cluster/rag-wire.test.ts
// The mappers between the data-cluster MCP wire shapes and the app's RAG
// shapes, shared by both runners. No network: the cluster payloads are literal.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { DataclusterMcpProtocolError } from "./datacluster-mcp-client"
import { chunkToPassage, liveEntryIds, pickLiveEntryId, toEntryContent } from "./rag-wire"

const ARK = "ark:/12148/bpt6k822781z"

test("chunkToPassage returns charRange null when the chunk has no char offsets", () => {
  // Every chunk indexed before worker-v2 wrote offsets looks like this. The
  // honest answer is "unknown", never [0, 0].
  const passage = chunkToPassage({
    id: "c1",
    score: 0.8,
    chunk_text: "texte",
    metadata: { ark: ARK, folio: 2, entry_id: 41 },
  })
  assert.ok(passage)
  assert.equal(passage.charRange, null)
  assert.equal(passage.folio, 2)
  assert.equal(passage.entryId, 41)
})

test("chunkToPassage carries the CONTRACT offsets of a page", () => {
  // Folio 9 of the CONTRACT sample in folio-text.test.ts: [39, 76] code points.
  const passage = chunkToPassage({
    id: "c1",
    score: 0.8,
    chunk_text: "Le 𝔊 gothique — Œuvre\nsur deux lignes",
    metadata: { ark: ARK, folio: 9, entry_id: 41, char_start: 39, char_end: 76 },
  })
  assert.ok(passage)
  assert.deepEqual(passage.charRange, [39, 76])
})

test("chunkToPassage refuses an offset pair that is not a range", () => {
  const chunk = (char_start: number | undefined, char_end: number | undefined) => ({
    id: "c1",
    score: 0.8,
    chunk_text: "texte",
    metadata: { ark: ARK, folio: 2, entry_id: 41, char_start, char_end },
  })
  assert.throws(() => chunkToPassage(chunk(17, 12)), DataclusterMcpProtocolError)
  assert.throws(() => chunkToPassage(chunk(-1, 4)), DataclusterMcpProtocolError)
  assert.throws(() => chunkToPassage(chunk(3, undefined)), DataclusterMcpProtocolError)
  assert.throws(() => chunkToPassage(chunk(1.5, 4)), DataclusterMcpProtocolError)
})

test("chunkToPassage drops a chunk with no ARK", () => {
  assert.equal(
    chunkToPassage({ id: "c", score: 1, chunk_text: "x", metadata: { folio: 1 } }),
    null,
  )
})

test("toEntryContent: full mode (no pagination fields) is the whole document, in code points", () => {
  // mcp-datacluster returns the raw stored payload in full mode (char_limit 0,
  // char_offset 0): only `text`, none of the pagination fields.
  const out = toEntryContent({ text: "ab😀d" }, { entryId: 7, charOffset: 0, charLimit: 0 })
  assert.deepEqual(out, {
    entryId: 7,
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
      entry_id: 7,
      text: "ef",
      char_offset: 4,
      char_limit: 4,
      total_length: 6,
      has_more: false,
      next_offset: null,
    },
    { entryId: 7, charOffset: 4, charLimit: 4 },
  )
  assert.deepEqual(out, {
    entryId: 7,
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
        { entryId: 7, charOffset: 0, charLimit: 4 },
      ),
    (err: unknown) =>
      err instanceof DataclusterMcpProtocolError && /has_more, next_offset/.test(err.message),
  )
})

test("toEntryContent: offset-only mode needs char_offset, total_length and has_more", () => {
  const out = toEntryContent(
    { text: "cdef", char_offset: 2, total_length: 6, has_more: false },
    { entryId: 7, charOffset: 2, charLimit: 0 },
  )
  assert.equal(out.charOffset, 2)
  assert.equal(out.charLimit, 0)
  assert.equal(out.nextOffset, 6)
  assert.throws(
    () => toEntryContent({ text: "cdef" }, { entryId: 7, charOffset: 2, charLimit: 0 }),
    DataclusterMcpProtocolError,
  )
})

test("liveEntryIds returns the ARK's entry ids; pickLiveEntryId takes the highest (newest after a re-ingest)", () => {
  const hit = (entry_id: number) => ({ entry_id, metadata: { ark: ARK } })
  const ids = liveEntryIds([hit(12), hit(40), hit(7)], 3, ARK)
  assert.deepEqual(ids, [12, 40, 7])
  assert.equal(pickLiveEntryId(ids), 40)
  assert.deepEqual(liveEntryIds([], 0, ARK), [])
  assert.equal(pickLiveEntryId([]), null)
})

test("liveEntryIds refuses a hit of another ARK or an invalid entry id", () => {
  assert.throws(
    () => liveEntryIds([{ entry_id: 3, metadata: { ark: "ark:/12148/bpt6k0000000" } }], 1, ARK),
    DataclusterMcpProtocolError,
  )
  assert.throws(() => liveEntryIds([{ entry_id: 3 }], 1, ARK), DataclusterMcpProtocolError)
  assert.throws(() => liveEntryIds([{ entry_id: "3", metadata: { ark: ARK } }], 1, ARK), DataclusterMcpProtocolError)
  assert.throws(() => liveEntryIds([{ entry_id: 0, metadata: { ark: ARK } }], 1, ARK), DataclusterMcpProtocolError)
})

test("liveEntryIds refuses an incomplete lookup (total beyond the hits) or one with no total", () => {
  const hit = { entry_id: 12, metadata: { ark: ARK } }
  assert.throws(() => liveEntryIds([hit], 6, ARK), /matched 6 entries but returned 1/)
  assert.throws(() => liveEntryIds([hit], undefined, ARK), /no pagination.total/)
})

test("toEntryContent: a paginated reply that contradicts itself or the request is a protocol error", () => {
  const req = { entryId: 7, charOffset: 0, charLimit: 4 }
  const page = { entry_id: 7, text: "abcd", char_offset: 0, char_limit: 4, total_length: 9, has_more: true, next_offset: 4 }
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
  const req = { entryId: 7, charOffset: 2, charLimit: 0 }
  assert.throws(() => toEntryContent({ text: "cdef", char_offset: 3, total_length: 6, has_more: false }, req), /inconsistent/)
  assert.throws(() => toEntryContent({ text: "cdef", char_offset: 2, total_length: 6, has_more: true }, req), /inconsistent/)
})

test("chunkToPassage refuses a folio or entry id that is not a positive integer", () => {
  const chunk = (folio: number, entry_id: number) => ({ id: "c", score: 1, chunk_text: "x", metadata: { ark: ARK, folio, entry_id } })
  assert.throws(() => chunkToPassage(chunk(0, 4)), /invalid folio/)
  assert.throws(() => chunkToPassage(chunk(-2, 4)), /invalid folio/)
  assert.throws(() => chunkToPassage(chunk(3, 0)), /invalid entry_id/)
  assert.equal(chunkToPassage(chunk(3, 4))?.folio, 3)
})

test("toEntryContent: a page must fit the document — length, total, has_more and the echoed entry id", () => {
  const req = { entryId: 7, charOffset: 0, charLimit: 4 }
  const page = { entry_id: 7, text: "abcd", char_offset: 0, char_limit: 4, total_length: 9, has_more: true, next_offset: 4 }
  for (const bad of [
    // the reviewer's probe: short text, a large total, no more, another entry
    { entry_id: 99, text: "0123456789", char_offset: 0, char_limit: 4, total_length: 9000, has_more: false, next_offset: null },
    { ...page, entry_id: 99 },
    { ...page, text: "abcdef", next_offset: 6 },
    { ...page, total_length: 3 },
    { ...page, total_length: 4, has_more: true },
    { ...page, entry_id: undefined },
  ]) {
    assert.throws(() => toEntryContent(bad, req), /inconsistent|omitted/, JSON.stringify(bad))
  }
  // Past the end: an empty slice and nothing more is consistent.
  const past = toEntryContent(
    { entry_id: 7, text: "", char_offset: 20, char_limit: 4, total_length: 9, has_more: false, next_offset: null },
    { entryId: 7, charOffset: 20, charLimit: 4 },
  )
  assert.equal(past.text, "")
})

test("toEntryContent: an offset-only slice must run to the end of the document", () => {
  const req = { entryId: 7, charOffset: 2, charLimit: 0 }
  assert.equal(toEntryContent({ text: "cdef", char_offset: 2, total_length: 6, has_more: false }, req).nextOffset, 6)
  assert.throws(() => toEntryContent({ text: "cd", char_offset: 2, total_length: 6, has_more: false }, req), /inconsistent/)
  assert.throws(
    () => toEntryContent({ entry_id: 8, text: "cdef", char_offset: 2, total_length: 6, has_more: false }, req),
    /inconsistent/,
  )
})
