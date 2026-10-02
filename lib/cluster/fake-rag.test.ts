// lib/cluster/fake-rag.test.ts
// Fake/real parity: the fake runner must serve the same folio-headed text,
// the same passage shape and the same entry-slice semantics as the real
// cluster, so anything that reads folio text (the quote check, the agent's
// rag_get_text) behaves identically in both cluster modes.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { FakeRagRunner } from "./fake-rag"
import { RAG_LOOKUP_STATUS } from "./rag"
import type { RagEntryContent, RagEntryContentResult } from "./rag"
import { RAG_FIXTURES } from "./rag-fixtures"
import { codePointLength, sliceCodePoints, splitEntryFolios } from "./folio-text"

// Le Figaro, 6 mai 1889 — two fixtures, folios 1 and 2, first ARK in the file.
const ARK = "ark:/12148/bpt6k2839841"
const PROJECT = "fake-project"
const signal = () => new AbortController().signal

const FIGARO = RAG_FIXTURES.filter((f) => f.ark === ARK)

/** The worker's format, written out literally: heading, page, separator. */
const FIGARO_BODY =
  `## Folio 1\n\n${FIGARO[0].snippet}` + "\n\n" + `## Folio 2\n\n${FIGARO[1].snippet}`

/** The content of a read the lookup vouched for. */
function contentOf(result: RagEntryContentResult): RagEntryContent {
  assert.equal(result.status, RAG_LOOKUP_STATUS.FOUND, JSON.stringify(result))
  if (result.status !== RAG_LOOKUP_STATUS.FOUND) throw new Error("unreachable after the assertion")
  return result.content
}

async function figaroEntryId(): Promise<number> {
  const hit = await FakeRagRunner.keywordSearch({
    projectId: PROJECT,
    query: "inauguration figaro",
    limit: 5,
    signal: signal(),
  })
  const entry = hit.hits.find((h) => h.ark === ARK)
  assert.ok(entry, "the Figaro fixture is a keyword hit")
  return entry.entryId
}

test("the fake body is the worker's literal format, and splits back into the fixture pages", async () => {
  assert.deepEqual(FIGARO.map((f) => f.folio), [1, 2])
  const content = contentOf(await FakeRagRunner.getEntryContent({
    projectId: PROJECT,
    ark: ARK,
    entryId: await figaroEntryId(),
    charOffset: 0,
    charLimit: 0,
    signal: signal(),
  }))
  assert.equal(content.text, FIGARO_BODY)
  assert.equal(content.totalLength, codePointLength(FIGARO_BODY))
  assert.deepEqual([...splitEntryFolios(content.text).entries()], FIGARO.map((f) => [f.folio, f.snippet]))
})

test("query passages have the real passage shape and code-point ranges that slice the body to the page", async () => {
  const res = await FakeRagRunner.query({
    projectId: PROJECT,
    query: "inauguration de l'Exposition Universelle",
    k: 20,
    signal: signal(),
  })
  const figaro = res.passages.filter((p) => p.ark === ARK)
  assert.ok(figaro.length >= 1, "at least one Figaro passage matches")
  for (const p of figaro) {
    assert.deepEqual(Object.keys(p).sort(), ["ark", "charRange", "entryId", "folio", "score", "snippet"])
    assert.ok(p.charRange, "fake passages always know their offsets")
    assert.equal(sliceCodePoints(FIGARO_BODY, p.charRange[0], p.charRange[1]), p.snippet)
  }
})

test("getEntryContent slices like mcp-datacluster: paginated by code point, with next_offset", async () => {
  const entryId = await figaroEntryId()
  const page = contentOf(
    await FakeRagRunner.getEntryContent({ projectId: PROJECT, ark: ARK, entryId, charOffset: 4, charLimit: 6, signal: signal() }),
  )
  assert.equal(page.text, sliceCodePoints(FIGARO_BODY, 4, 10))
  assert.equal(page.hasMore, true)
  assert.equal(page.nextOffset, 10)
  const rest = contentOf(
    await FakeRagRunner.getEntryContent({ projectId: PROJECT, ark: ARK, entryId, charOffset: 10, charLimit: 0, signal: signal() }),
  )
  assert.equal(rest.text, sliceCodePoints(FIGARO_BODY, 10))
  assert.equal(rest.hasMore, false)
})

test("an entry id the ARK does not own is refused as not in the corpus, as on the real path", async () => {
  const entryId = await figaroEntryId()
  const other = await FakeRagRunner.getEntryContent({
    projectId: PROJECT, ark: ARK, entryId: entryId + 1, charOffset: 0, charLimit: 0, signal: signal(),
  })
  assert.deepEqual(other, { status: RAG_LOOKUP_STATUS.ENTRY_NOT_IN_CORPUS, liveEntryIds: [entryId] })
  const unknownArk = await FakeRagRunner.getEntryContent({
    projectId: PROJECT, ark: "ark:/12148/bpt6k0000000", entryId, charOffset: 0, charLimit: 0, signal: signal(),
  })
  assert.deepEqual(unknownArk, { status: RAG_LOOKUP_STATUS.ENTRY_NOT_IN_CORPUS, liveEntryIds: [] })
})

test("an aborted signal stops the fake as it stops the real client", async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    FakeRagRunner.query({ projectId: PROJECT, query: "figaro", k: 5, signal: controller.signal }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  )
})

test("getDocumentFolios resolves an ARK to its folio map, and reports an unknown ARK", async () => {
  const found = await FakeRagRunner.getDocumentFolios({ projectId: PROJECT, ark: ARK, signal: signal() })
  assert.equal(found.status, RAG_LOOKUP_STATUS.FOUND)
  if (found.status !== RAG_LOOKUP_STATUS.FOUND) return
  assert.deepEqual([...found.folios.keys()], [1, 2])
  const folio2 = found.folios.get(2)
  assert.ok(folio2 !== undefined, "folio 2 is present")
  assert.match(folio2, /fête du travail et de la paix/)

  const missing = await FakeRagRunner.getDocumentFolios({
    projectId: PROJECT,
    ark: "ark:/12148/bpt6k0000000",
    signal: signal(),
  })
  assert.deepEqual(missing, { status: RAG_LOOKUP_STATUS.ENTRY_NOT_FOUND })
})

test("keywordSearch total counts every matching entry, not just the returned page", async () => {
  const all = await FakeRagRunner.keywordSearch({ projectId: PROJECT, query: "exposition", limit: 100, signal: signal() })
  const one = await FakeRagRunner.keywordSearch({ projectId: PROJECT, query: "exposition", limit: 1, signal: signal() })
  assert.ok(all.hits.length > 1, "the query matches several entries")
  assert.equal(one.hits.length, 1)
  assert.equal(one.total, all.hits.length)
})
