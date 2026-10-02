// lib/cluster/rag-wire.test.ts
// The mappers between the data-cluster MCP wire shapes and the app's RAG
// shapes, shared by both runners. No network: the cluster payloads are literal.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { DataclusterMcpProtocolError } from "./datacluster-mcp-client"
import { chunkToPassage, pickLiveEntryId, toEntryContent } from "./rag-wire"

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

test("pickLiveEntryId takes the highest entry id (the newest after a re-ingest)", () => {
  const hit = (entry_id: number) => ({ entry_id, metadata: { ark: ARK } })
  assert.equal(pickLiveEntryId([hit(12), hit(40), hit(7)], ARK), 40)
  assert.equal(pickLiveEntryId([], ARK), null)
})

test("pickLiveEntryId refuses a hit of another ARK or an invalid entry id", () => {
  assert.throws(
    () => pickLiveEntryId([{ entry_id: 3, metadata: { ark: "ark:/12148/bpt6k0000000" } }], ARK),
    DataclusterMcpProtocolError,
  )
  assert.throws(() => pickLiveEntryId([{ entry_id: 3 }], ARK), DataclusterMcpProtocolError)
  assert.throws(() => pickLiveEntryId([{ entry_id: "3", metadata: { ark: ARK } }], ARK), DataclusterMcpProtocolError)
  assert.throws(() => pickLiveEntryId([{ entry_id: 0, metadata: { ark: ARK } }], ARK), DataclusterMcpProtocolError)
})
