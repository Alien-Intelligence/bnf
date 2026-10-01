// lib/cluster/fake-rag.test.ts
// Fake/real parity for entry text: the fake runner must serve the same
// folio-headed document shape worker-v2 writes, so anything that reads folio
// text (the quote check, the agent's rag_get_text) behaves identically in both
// cluster modes.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { FakeRagRunner } from "./fake-rag"
import { RAG_FIXTURES } from "./rag-fixtures"
import { splitEntryFolios } from "./folio-text"

// Le Figaro, 6 mai 1889 — two fixtures, folios 1 and 2, first ARK in the file.
const ARK = "ark:/12148/bpt6k2839841"
const PROJECT = "fake-project"
const INGESTED = "fake-version"

test("getEntryContent text carries `## Folio N` headings and splitEntryFolios recovers each fixture folio", async () => {
  const hit = await FakeRagRunner.keywordSearch({
    projectId: PROJECT,
    ingestedVersionId: INGESTED,
    query: "inauguration figaro",
    limit: 5,
  })
  const entry = hit.hits.find((h) => h.ark === ARK)
  assert.ok(entry, "the Figaro fixture is a keyword hit")

  const content = await FakeRagRunner.getEntryContent({
    projectId: PROJECT,
    entryId: entry.entryId,
    charOffset: 0,
    charLimit: 0,
  })
  assert.match(content.text, /^## Folio 1\n\n/)

  const folios = splitEntryFolios(content.text)
  const expected = RAG_FIXTURES.filter((f) => f.ark === ARK)
  assert.deepEqual([...folios.keys()], expected.map((f) => f.folio))
  for (const f of expected) {
    assert.notEqual(f.folio, null, "the Figaro fixtures all carry a folio")
    if (f.folio === null) continue
    assert.equal(folios.get(f.folio), f.snippet)
  }
})

test("query passages carry a charRange that slices the folio-headed body to the snippet", async () => {
  const res = await FakeRagRunner.query({
    projectId: PROJECT,
    ingestedVersionId: INGESTED,
    query: "inauguration de l'Exposition Universelle",
    k: 20,
  })
  const figaro = res.passages.filter((p) => p.ark === ARK)
  assert.ok(figaro.length >= 1, "at least one Figaro passage matches")
  const body = (
    await FakeRagRunner.getEntryContent({
      projectId: PROJECT,
      entryId: figaro[0].entryId ?? -1,
      charOffset: 0,
      charLimit: 0,
    })
  ).text
  for (const p of figaro) {
    assert.ok(p.charRange, "fake passages always know their offsets")
    assert.equal(body.slice(p.charRange[0], p.charRange[1]), p.snippet)
  }
})

test("getDocumentFolios resolves an ARK to its folio map, and reports an unknown ARK", async () => {
  const found = await FakeRagRunner.getDocumentFolios({
    projectId: PROJECT,
    ark: ARK,
    signal: new AbortController().signal,
  })
  assert.equal(found.status, "found")
  if (found.status !== "found") return
  assert.deepEqual([...found.folios.keys()], [1, 2])
  assert.match(found.folios.get(2) ?? "", /fête du travail et de la paix/)

  const missing = await FakeRagRunner.getDocumentFolios({
    projectId: PROJECT,
    ark: "ark:/12148/bpt6k0000000",
    signal: new AbortController().signal,
  })
  assert.deepEqual(missing, { status: "entry_not_found" })
})
