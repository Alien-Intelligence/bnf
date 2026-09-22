// app/api/_corpus-filters.test.ts
// corpusFiltersToFilterSet — the single wire-form → query-layer conversion, now
// shared by GET /corpus and GET /corpus/export.
//
// It is tested because both routes depend on it agreeing with itself: the CSV
// export exists to hand a librarian exactly the set on screen, so a conversion
// that behaved differently per route would produce an export that silently
// disagreed with the panel it was taken from. Pure function, no Prisma.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import { corpusFiltersToFilterSet } from "@/app/api/_corpus-filters"
import { corpusFiltersToParams } from "@/models/corpus/types"

test("no filter set → undefined, not an empty object", () => {
  // The query layer treats undefined as "no filter" and an object as "these
  // filters"; returning {} for an unfiltered request would still be correct
  // today but states something the caller did not ask for.
  assert.equal(corpusFiltersToFilterSet({}), undefined)
})

test("CSV multi-selects become arrays, whitespace and empties dropped", () => {
  const set = corpusFiltersToFilterSet({ type: " book , press ,, " })
  assert.deepEqual(set?.type, ["book", "press"])
})

test("a whitespace-only value is no filter, never an empty match", () => {
  // `{ type: [] }` would reach Prisma as "in []" and match nothing, turning a
  // malformed query string into an empty corpus.
  assert.equal(corpusFiltersToFilterSet({ type: " , , " }), undefined)
})

test("every dimension survives the round trip", () => {
  // Guards the two routes drifting from the client: whatever
  // corpusFiltersToParams writes into the URL, this must read back out.
  const filters = {
    type: "book",
    lang: "fr",
    source: "gallica",
    session: "s1",
    ingest: "ocr",
    outcome: "failed,not_ingested",
    yearFrom: 1880,
    yearTo: 1889,
    undated: false,
    q: "perfumery",
  }
  const params = corpusFiltersToParams(filters)
  for (const key of Object.keys(filters)) {
    assert.ok(params.has(key), `${key} is not serialised into the query string`)
  }

  const set = corpusFiltersToFilterSet(filters)
  assert.deepEqual(set, {
    type: ["book"],
    lang: ["fr"],
    source: ["gallica"],
    session: ["s1"],
    ingest: ["ocr"],
    outcome: ["failed", "not_ingested"],
    yearFrom: 1880,
    yearTo: 1889,
    undated: false,
    q: "perfumery",
  })
})

test("a lone outcome filter is active on its own", () => {
  // The regression to avoid: a new dimension added to the schema but forgotten
  // in the conversion reads as "no filters at all", so the route quietly
  // returns the whole corpus instead of the failures the librarian asked for.
  const set = corpusFiltersToFilterSet({ outcome: "failed" })
  assert.deepEqual(set?.outcome, ["failed"])
})
