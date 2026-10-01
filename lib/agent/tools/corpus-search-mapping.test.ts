// lib/agent/tools/corpus-search-mapping.test.ts
// Pure guards on corpus_search's input handling (incident 2026-09-30, root
// causes 3 and 5): the catalogue pages at up to 1 000 records so a sweep costs
// 1/20 of the calls, and `subject` / `author` are passed through instead of
// being stripped and failing the at-least-one-criterion check — which made the
// agent retry variations and add to the flood.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  BUFFER_SEARCH_DEFAULT_PAGE_SIZE_BY_SOURCE,
  BUFFER_SEARCH_MAX_PAGE_SIZE_BY_SOURCE,
} from "@/lib/constants"
import { buildSearchArgs, resolveSearchPageSize, searchCriterionProblems } from "./buffer"

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
