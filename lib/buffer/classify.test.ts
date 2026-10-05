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

test("bufferMetadataFromDocument copies the resolved document, its raw label, links and year range", () => {
  const unknown: string[] = []
  const meta = bufferMetadataFromDocument(
    {
      ark: "ark:/12148/btv1b1",
      title: "Vue du village suisse",
      author: "Anonyme",
      year: 1896,
      dateLabel: "1896",
      docType: "image",
      lang: "fre",
      rawMetadata: {
        doc_type: "image fixe",
        publisher: " Neurdein ",
        subject: ["Expositions -- Genève", "", "Chalets"],
        gallica_url: "https://gallica.bnf.fr/ark:/12148/btv1b1",
      },
    },
    (label) => unknown.push(label),
  )
  assert.deepEqual(meta, {
    title: "Vue du village suisse",
    creator: "Anonyme",
    year: 1896,
    yearEnd: null,
    dateLabel: "1896",
    docType: "image",
    docTypeRaw: "image fixe",
    lang: "fr",
    publisher: "Neurdein",
    subjects: "Expositions -- Genève ; Chalets",
    gallicaUrl: "https://gallica.bnf.fr/ark:/12148/btv1b1",
    catalogueUrl: null,
    arkKind: "image",
  })
  assert.deepEqual(unknown, [])
})

test("the record's type follows the search-hit rules: typedoc, then label, never a guessed book", () => {
  const unknown: string[] = []
  const base = { ark: "ark:/12148/cb1", title: "Le Temps", author: null, year: 1861, lang: null }
  const typeless = bufferMetadataFromDocument(
    { ...base, dateLabel: "1861-1946", docType: "book", rawMetadata: { title: "Le Temps" } },
    (l) => unknown.push(l),
  )
  assert.equal(typeless.docType, null, "a record with no type is unknown, not the normaliser's `book` guess")
  assert.equal(typeless.yearEnd, 1946, "a range label sets yearEnd")
  assert.equal(typeless.arkKind, "catalogue_notice")
  const odd = bufferMetadataFromDocument(
    { ...base, dateLabel: null, docType: "other", rawMetadata: { doc_type: "Zorglub" } },
    (l) => unknown.push(l),
  )
  assert.equal(odd.docType, "other")
  assert.deepEqual(unknown, ["Zorglub"], "an unknown label is reported")
  const issue = bufferMetadataFromDocument(
    { ...base, ark: "ark:/12148/bpt6k1", dateLabel: null, docType: "book", rawMetadata: { gallica_typedoc: "periodiques:fascicules", doc_type: "texte" } },
    (l) => unknown.push(l),
  )
  assert.equal(issue.docType, "press", "the typedoc wins")
  assert.equal(issue.arkKind, "periodical_issue")
  const bare = bufferMetadataFromDocument(
    { ...base, title: null, dateLabel: null, docType: "press", rawMetadata: null },
    (l) => unknown.push(l),
  )
  assert.equal(bare.docType, "press", "no preserved payload: the Document's canonical type stands")
  assert.equal(bare.publisher, null)
})

test("searchDocTypeFromCql reads only an unambiguous dc.type clause", () => {
  assert.equal(searchDocTypeFromCql('dc.type all "fascicule" and gallica all "incendie"'), "fascicule")
  assert.equal(searchDocTypeFromCql('not dc.type all "fascicule"'), null, "a negation says what hits are NOT")
  assert.equal(searchDocTypeFromCql('gallica all "x" not dc.type all "fascicule"'), null)
  assert.equal(searchDocTypeFromCql('dc.type all "fascicule" or dc.type all "monographie"'), null, "two types")
  assert.equal(searchDocTypeFromCql('dc.type all "fascicule" or title all "Temps"'), null, "an or widens the set")
  assert.equal(searchDocTypeFromCql(null), null)
})
