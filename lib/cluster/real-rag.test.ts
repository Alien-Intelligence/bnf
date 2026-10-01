// lib/cluster/real-rag.test.ts
// The pure mappers between the data-cluster MCP wire shapes and the app's RAG
// shapes. No network: the cluster payloads are literal.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { chunkToPassage, pickLiveEntryId, toEntryContent } from "./real-rag"

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

test("chunkToPassage carries real offsets when both are present", () => {
  const passage = chunkToPassage({
    id: "c1",
    score: 0.8,
    chunk_text: "texte",
    metadata: { ark: ARK, folio: 2, entry_id: 41, char_start: 12, char_end: 17 },
  })
  assert.ok(passage)
  assert.deepEqual(passage.charRange, [12, 17])
})

test("chunkToPassage drops a chunk with no ARK", () => {
  assert.equal(
    chunkToPassage({ id: "c", score: 1, chunk_text: "x", metadata: { folio: 1 } }),
    null,
  )
})

test("toEntryContent maps a full-mode payload (no pagination fields) to totalLength = text.length, hasMore false", () => {
  // mcp-datacluster returns the raw stored payload in full mode (char_limit 0,
  // char_offset 0): only `text`, none of the pagination fields.
  const out = toEntryContent({ text: "abcdef" }, { entryId: 7, charOffset: 0, charLimit: 0 })
  assert.deepEqual(out, {
    entryId: 7,
    text: "abcdef",
    charOffset: 0,
    charLimit: 0,
    totalLength: 6,
    hasMore: false,
    nextOffset: 6,
  })
})

test("toEntryContent passes a paginated payload through and resolves a null next_offset", () => {
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

test("toEntryContent echoes the request offset in offset-only mode", () => {
  // char_offset > 0 with char_limit 0: the MCP returns text from the offset to
  // the end, with char_offset / total_length / has_more but no char_limit.
  const out = toEntryContent(
    { text: "cdef", char_offset: 2, total_length: 6, has_more: false },
    { entryId: 7, charOffset: 2, charLimit: 0 },
  )
  assert.equal(out.charOffset, 2)
  assert.equal(out.charLimit, 0)
  assert.equal(out.nextOffset, 6)
})

test("pickLiveEntryId takes the highest entry id (the newest after a re-ingest)", () => {
  assert.equal(pickLiveEntryId([{ entry_id: 12 }, { entry_id: 40 }, { entry_id: 7 }]), 40)
  assert.equal(pickLiveEntryId([]), null)
})
