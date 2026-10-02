// lib/buffer/classify.test.ts
// The buffer classification rules shared by the staging tools, the boot
// reclassifier and the enrichment drain. Pure, no DB.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  bufferMetadataFromDocument,
  canonicalBufferDocType,
  classifyLegacyRow,
  gallicaSearchDocType,
  searchDocTypeFromCql,
} from "./classify"

test("searchDocTypeFromCql recovers the dc.type clause mcp-bnf writes, and only searchable values", () => {
  assert.equal(searchDocTypeFromCql('gallica all "x" and dc.type all "fascicule"'), "fascicule")
  assert.equal(searchDocTypeFromCql('dc.type ANY "Monographie"'), "monographie")
  assert.equal(searchDocTypeFromCql('dc.type adj "carte"'), "carte")
  assert.equal(searchDocTypeFromCql('dc.type all "typeAffiche"'), null, "a label Gallica never accepts as a filter")
  assert.equal(searchDocTypeFromCql('bib.subject all "Alamans"'), null)
  assert.equal(searchDocTypeFromCql(null), null)
})

test("gallicaSearchDocType prefers the structured filter, then the CQL", () => {
  assert.equal(gallicaSearchDocType("fascicule", 'dc.type all "monographie"'), "fascicule")
  assert.equal(gallicaSearchDocType(undefined, 'x and dc.type all "image"'), "image")
  assert.equal(gallicaSearchDocType("nonsense", undefined), null)
})

test("the search filter wins over the hit label; without one, the label is folded", () => {
  assert.deepEqual(canonicalBufferDocType("text", "fascicule"), { code: "press", known: true })
  assert.deepEqual(canonicalBufferDocType("text", null), { code: "text", known: true })
  assert.deepEqual(canonicalBufferDocType("Zorglub", null), { code: "other", known: false })
  assert.deepEqual(canonicalBufferDocType(undefined, null), { code: null, known: true })
})

test("classifyLegacyRow only trusts the CQL of a corpus_search row", () => {
  const cql = 'gallica all "x" and dc.type all "fascicule"'
  const searched = classifyLegacyRow({
    ark: "ark:/12148/bpt6k1", docType: "Texte", lang: "fre", originTool: "corpus_search", originQuery: cql, source: "gallica",
  })
  assert.deepEqual(searched, { docTypeRaw: "Texte", docType: "press", lang: "fr", arkKind: "periodical_issue", unknownLabel: null })

  // A buffer_add row's originQuery is not a search: the label alone decides.
  const added = classifyLegacyRow({
    ark: "ark:/12148/bpt6k1", docType: "Texte", lang: null, originTool: "buffer_add", originQuery: cql, source: "gallica",
  })
  assert.equal(added.docType, "text")
  assert.equal(added.arkKind, "unknown")

  const unknown = classifyLegacyRow({
    ark: "ark:/12148/bpt6k1", docType: "Zorglub", lang: null, originTool: "corpus_search", originQuery: null, source: "gallica",
  })
  assert.equal(unknown.unknownLabel, "Zorglub")
})

test("bufferMetadataFromDocument copies the resolved document and its raw publisher/subjects", () => {
  const meta = bufferMetadataFromDocument({
    ark: "ark:/12148/btv1b1",
    title: "Vue du village suisse",
    author: "Anonyme",
    year: 1896,
    dateLabel: "1896",
    docType: "image",
    lang: "fre",
    rawMetadata: { publisher: " Neurdein ", subject: ["Expositions -- Genève", "", "Chalets"] },
  })
  assert.deepEqual(meta, {
    title: "Vue du village suisse",
    creator: "Anonyme",
    year: 1896,
    dateLabel: "1896",
    docType: "image",
    lang: "fr",
    publisher: "Neurdein",
    subjects: "Expositions -- Genève ; Chalets",
    arkKind: "image",
  })
  const bare = bufferMetadataFromDocument({
    ark: "ark:/12148/cb1", title: null, author: null, year: null, dateLabel: null, docType: null, lang: null, rawMetadata: null,
  })
  assert.equal(bare.publisher, null)
  assert.equal(bare.subjects, null)
  assert.equal(bare.arkKind, "catalogue_notice")
})
