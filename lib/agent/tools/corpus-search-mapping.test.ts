// lib/agent/tools/corpus-search-mapping.test.ts
// Pure guards on corpus_search's input handling and hit mapping.
// Phase 2 (incident 2026-09-30, root causes 3 and 5): the catalogue pages at up
// to 1 000 records so a sweep costs 1/20 of the calls, and `subject` / `author`
// are passed through instead of being stripped and failing the
// at-least-one-criterion check — which made the agent retry variations and add
// to the flood.
// Phase 7 (#10a): every useful mcp-bnf parameter is exposed, a parameter the
// source cannot honour is REJECTED (never silently dropped), and every useful
// hit field reaches the buffer row with its canonical type and record kind.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  BUFFER_SEARCH_DEFAULT_PAGE_SIZE_BY_SOURCE,
  BUFFER_SEARCH_MAX_PAGE_SIZE_BY_SOURCE,
} from "@/lib/constants"
import {
  buildSearchArgs,
  candidateFromCatalogueHit,
  candidateFromGallicaHit,
  incompatibleSearchParams,
  resolveSearchPageSize,
  searchCriterionProblems,
  type CatalogueHit,
  type GallicaHit,
} from "./buffer"

test("page size: the catalogue accepts 1000, Gallica refuses 51, defaults are per source", () => {
  assert.deepEqual(resolveSearchPageSize("catalogue", 1000), { ok: true, pageSize: 1000 })
  assert.deepEqual(resolveSearchPageSize("gallica", 50), { ok: true, pageSize: 50 })

  const refused = resolveSearchPageSize("gallica", 51)
  assert.equal(refused.ok, false)
  assert.ok(refused.ok === false && refused.problems.some((p) => /gallica : 50 résultats maximum par page/.test(p)))

  assert.deepEqual(resolveSearchPageSize("gallica", undefined), {
    ok: true,
    pageSize: BUFFER_SEARCH_DEFAULT_PAGE_SIZE_BY_SOURCE.gallica,
  })
  assert.deepEqual(resolveSearchPageSize("catalogue", undefined), {
    ok: true,
    pageSize: BUFFER_SEARCH_DEFAULT_PAGE_SIZE_BY_SOURCE.catalogue,
  })
  assert.equal(BUFFER_SEARCH_MAX_PAGE_SIZE_BY_SOURCE.gallica, 50)
  assert.equal(BUFFER_SEARCH_MAX_PAGE_SIZE_BY_SOURCE.catalogue, 1000)
})

test("subject alone satisfies the at-least-one-criterion check", () => {
  assert.deepEqual(searchCriterionProblems({ source: "catalogue", subject: "Coiffure" }), [])
  assert.deepEqual(searchCriterionProblems({ source: "gallica", author: "Hugo" }), [])
  const none = searchCriterionProblems({ source: "catalogue" })
  assert.equal(none.length, 1)
  assert.match(none[0], /subject/)
  assert.match(none[0], /author/)
})

test("author is an alias of creator; both at once is refused", () => {
  const both = searchCriterionProblems({ source: "catalogue", creator: "Hugo", author: "Hugo" })
  assert.equal(both.length, 1)
  assert.match(both[0], /creator.*author|author.*creator/)
})

test("author / creator reach the catalogue as `author` and Gallica as `creator`; subject goes to both", () => {
  const catalogue = buildSearchArgs({ source: "catalogue", author: "Hugo", subject: "Coiffure" }, 500)
  assert.equal(catalogue.author, "Hugo")
  assert.equal(catalogue.subject, "Coiffure")
  assert.equal(catalogue.maximum_records, 500)
  assert.equal("creator" in catalogue, false)

  const viaCreator = buildSearchArgs({ source: "catalogue", creator: "Hugo" }, 500)
  assert.equal(viaCreator.author, "Hugo")

  const gallica = buildSearchArgs({ source: "gallica", author: "Hugo", subject: "Coiffure" }, 50)
  assert.equal(gallica.creator, "Hugo")
  assert.equal(gallica.subject, "Coiffure")
  assert.equal("author" in gallica, false)
})

// --- Phase 7: hit mapping ----------------------------------------------------

function gallicaHit(over: Partial<GallicaHit>): GallicaHit {
  return {
    ark: "bpt6k7600001",
    title: null,
    creator: null,
    date: null,
    subject: null,
    description: null,
    doc_type: null,
    language: null,
    gallica_url: null,
    ...over,
  }
}

test("a cb…/date collection entry keeps its notice ARK and is a periodical collection", () => {
  const c = candidateFromGallicaHit(
    gallicaHit({ ark: "cb34355551z/date", title: "Le Temps", doc_type: "text", date: "1861-1946" }),
    { docTypeFilter: "fascicule", collapsing: true },
  )
  assert.ok(c)
  assert.equal(c.ark, "ark:/12148/cb34355551z")
  assert.equal(c.arkKind, "periodical_collection")
  assert.equal(c.docType, "press")
  assert.equal(c.docTypeRaw, "text")
  assert.equal(c.searchCollapsing, true)
})

test("an individual press issue carries its date label, creator and joined subjects", () => {
  const c = candidateFromGallicaHit(
    gallicaHit({
      ark: "bpt6k7549530",
      title: "Le Petit Journal",
      creator: "Collectif",
      date: "1937-07-12",
      subject: ["Incendies de forêt -- France", "Var (France)"],
      doc_type: "text",
      language: "fre",
      gallica_url: "https://gallica.bnf.fr/ark:/12148/bpt6k7549530",
    }),
    { docTypeFilter: "fascicule", collapsing: false },
  )
  assert.ok(c)
  assert.equal(c.arkKind, "periodical_issue")
  assert.equal(c.dateLabel, "1937-07-12")
  assert.equal(c.year, 1937)
  assert.equal(c.yearEnd, undefined, "a single date has no end year")
  assert.equal(c.creator, "Collectif")
  assert.equal(c.subjects, "Incendies de forêt -- France ; Var (France)")
  assert.equal(c.lang, "fr")
  assert.equal(c.gallicaUrl, "https://gallica.bnf.fr/ark:/12148/bpt6k7549530")
  assert.equal(c.searchCollapsing, false)
  assert.equal(c.typeAmbiguous, false)
})

test("`text` without a doc_type filter stays ambiguous, never a book", () => {
  const c = candidateFromGallicaHit(gallicaHit({ doc_type: "text" }), { docTypeFilter: null, collapsing: true })
  assert.ok(c)
  assert.equal(c.docType, "text")
  assert.equal(c.arkKind, "unknown")
  assert.equal(c.typeAmbiguous, true)
})

test("a collection's range label keeps its first and last year", () => {
  const c = candidateFromGallicaHit(gallicaHit({ ark: "cb3270000x/date", date: "1861-1946" }), {
    docTypeFilter: "fascicule",
    collapsing: true,
  })
  assert.ok(c)
  assert.equal(c.year, 1861)
  assert.equal(c.yearEnd, 1946)
  assert.equal(c.dateLabel, "1861-1946")
})

test("an unusable Gallica identifier is dropped", () => {
  assert.equal(candidateFromGallicaHit(gallicaHit({ ark: "  " }), { docTypeFilter: null, collapsing: true }), null)
})

test("a catalogue hit keeps author, publisher and both URLs, and is a catalogue notice", () => {
  const hit: CatalogueHit = {
    ark: "cb12000001z",
    title: "Les Alamans",
    author: "Geuenich, Dieter",
    date: "1997",
    publisher: "Kohlhammer",
    language: "ger",
    isbn: "3170127621",
    issn: null,
    catalogue_url: "https://catalogue.bnf.fr/ark:/12148/cb12000001z",
    gallica_url: null,
  }
  const c = candidateFromCatalogueHit(hit)
  assert.ok(c)
  assert.equal(c.creator, "Geuenich, Dieter")
  assert.equal(c.publisher, "Kohlhammer")
  assert.equal(c.catalogueUrl, "https://catalogue.bnf.fr/ark:/12148/cb12000001z")
  assert.equal(c.gallicaUrl, undefined)
  assert.equal(c.lang, "de")
  assert.equal(c.docType, undefined, "the catalogue payload carries no type")
  assert.equal(c.arkKind, "catalogue_notice")
  assert.equal(c.dateLabel, "1997")
  assert.equal(c.year, 1997)
})

// --- Phase 7: source compatibility (the silent drops were the found bug) ------

test("parameters the chosen source cannot honour are rejected with a fix", () => {
  const catalogueDocType = incompatibleSearchParams({ source: "catalogue", query: "x", doc_type: "fascicule" })
  assert.equal(catalogueDocType.length, 1)
  assert.match(catalogueDocType[0], /doc_type/)

  const gallicaRange = incompatibleSearchParams({ source: "gallica", query: "x", date_from: "1850" })
  assert.equal(gallicaRange.length, 1)
  assert.match(gallicaRange[0], /dc\.date >= "1850"/)

  const cqlTitle = incompatibleSearchParams({ source: "gallica", cql: 'dc.title all "x"', title: "y" })
  assert.equal(cqlTitle.length, 1)
  assert.match(cqlTitle[0], /Intègre ces critères dans le CQL/)

  const cqlSort = incompatibleSearchParams({ source: "gallica", cql: 'gallica all "x"', sort: "dc.date/sort.ascending" })
  assert.equal(cqlSort.length, 1)
  assert.match(cqlSort[0], /sortBy dc\.date\/sort\.ascending/)

  assert.deepEqual(incompatibleSearchParams({ source: "gallica", cql: 'gallica all "x"', collapsing: false }), [])
  assert.deepEqual(
    incompatibleSearchParams({ source: "catalogue", subject: "Alamans", date_from: "1960", shelfmark: "8-H-1" }),
    [],
  )
})

test("the new criteria reach mcp-bnf under their own names, collapsing in both modes", () => {
  const press = buildSearchArgs(
    { source: "gallica", query: "incendie", doc_type: "fascicule", collapsing: false, sort: "dc.date/sort.ascending", shelfmark: "JO-1" },
    50,
  )
  assert.equal(press.collapsing, false)
  assert.equal(press.sort, "dc.date/sort.ascending")
  assert.equal(press.shelfmark, "JO-1")
  assert.equal(press.doc_type, "fascicule")

  const raw = buildSearchArgs({ source: "gallica", cql: 'gallica all "x"', collapsing: false }, 50)
  assert.equal(raw.cql, 'gallica all "x"')
  assert.equal(raw.collapsing, false)

  const range = buildSearchArgs({ source: "catalogue", subject: "Alamans", date_from: "1960", date_to: "1990" }, 500)
  assert.equal(range.date_from, "1960")
  assert.equal(range.date_to, "1990")
  assert.equal("collapsing" in range, false)
})

test("shelfmark and the catalogue range satisfy the at-least-one-criterion check", () => {
  assert.deepEqual(searchCriterionProblems({ source: "catalogue", shelfmark: "8-H-1" }), [])
  assert.deepEqual(searchCriterionProblems({ source: "catalogue", date_from: "1960" }), [])
})
