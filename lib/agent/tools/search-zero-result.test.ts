// lib/agent/tools/search-zero-result.test.ts
// The narrowing heuristic behind corpus_search's `zero_result` block, and the
// failure detection that stops an app-tool error recording as "ok".
//
// Cases are the REAL queries from the 2026-09-15 incident: the corpus agent told
// a BnF curator that Cadoricin and Cadonett had "aucune trace au catalogue ni sur
// Gallica" while 68 documents from those very searches sat committed in her
// corpus. Every zeroed query below is one the agent actually issued, so a
// regression here is a regression against the thing that went wrong.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { mostDistinctiveTerm } from "./buffer"
import { toolCallErrored } from "@/lib/tools/display"

test("picks the proper noun out of a descriptive query", () => {
  // Left: what the agent typed (catalogue total = 0).
  // Right: the term that actually matches records.
  const cases: Array<[string, string]> = [
    ["Maybelline maquillage", "Maybelline"],
    ["Vichy marque cosmétiques beauté", "Vichy"],
    ["Cadoricin dépilation épilation produit", "Cadoricin"],
    ["Cadonett produit beauté soin", "Cadonett"],
    ["DOP savon produits beauté", "DOP"],
    ["Carita salon beauté Paris", "Carita"],
    ["Gemey Maybelline cosmétique maquillage", "Maybelline"],
    ["Francis Jourdain ensemblier décorateur", "Jourdain"],
  ]
  for (const [query, expected] of cases) {
    assert.equal(mostDistinctiveTerm(query), expected, `narrowing "${query}"`)
  }
})

test("demotes the generic word that leads an institutional name", () => {
  // "Laboratoires" outranks "Vichy" on every structural signal — capitalised,
  // leading, longer — and is a useless search term.
  assert.equal(mostDistinctiveTerm("Laboratoires Vichy soins dermatologie"), "Vichy")
  assert.equal(mostDistinctiveTerm("Établissements Cadoricin documents"), "Cadoricin")
})

test("strips the elided article so the name itself is probed", () => {
  // Never "L" — the elided article must not become the probed term.
  assert.equal(mostDistinctiveTerm("L'Oréal cosmétiques"), "Oréal")
  assert.equal(mostDistinctiveTerm("l'aventure L'Oréal"), "Oréal")
  assert.equal(mostDistinctiveTerm("d'Alembert encyclopédie"), "Alembert")
})

test("a query naming two brands may probe either — both contradict the zero", () => {
  // "Monsavon savon L'Oréal marque" narrows to Monsavon rather than Oréal. That
  // is fine: the probe's job is to produce a count that disproves "the BnF holds
  // nothing", and the diagnostic tells the agent to re-search on ITS subject
  // rather than on this term. Pinned so the choice stays deliberate.
  assert.equal(mostDistinctiveTerm("Monsavon savon L'Oréal marque"), "Monsavon")
})

test("falls back to the longest term when nothing is capitalised", () => {
  assert.equal(
    mostDistinctiveTerm("industrie parfumerie cosmétiques histoire marques"),
    "cosmétiques",
  )
})

test("returns null when there is nothing to narrow to", () => {
  // A single term is already as narrow as it gets — probing it would just repeat
  // the search that returned zero, so the diagnostic falls back to prose.
  assert.equal(mostDistinctiveTerm("Cadoricin"), null)
  assert.equal(mostDistinctiveTerm("  Cadonett  "), null)
  assert.equal(mostDistinctiveTerm(""), null)
  // Two tokens that collapse to one usable term must not re-propose that term.
  assert.equal(mostDistinctiveTerm("de la"), null)
})

test("a corpus_search failure records as an error, not an ok", () => {
  // corpus_search never throws — it coerces the failure into a tool result. The
  // `success: false` flag is what makes it count as a failure downstream; before
  // it, a BnF outage persisted as status "ok" and the health lane stayed green.
  const failure = {
    content: JSON.stringify({
      success: false,
      error: "La recherche BnF a échoué : MCP bnf_search_catalogue: HTTP 500",
    }),
  }
  assert.equal(toolCallErrored(false, failure), true)
})

test("routine { error } outcomes must NOT be treated as failures", () => {
  // The regression guard. Several handlers use `{ error }` for EXPECTED states:
  // rag_* before the corpus is ingested, doc_get on an ARK outside the corpus.
  // Those are normal answers in a Step 1 → Step 3 workflow. Keying failure
  // detection on the mere presence of an `error` key would flare the health
  // lanes on every one of them, so detection keys on `success: false` instead.
  const notIngested = {
    content: JSON.stringify({ passages: [], total: 0, error: "not_ingested" }),
  }
  assert.equal(toolCallErrored(false, notIngested), false)

  const notInCorpus = {
    content: JSON.stringify({ error: "ark_not_in_corpus", ark: "ark:/12148/bpt6k1", message: "…" }),
  }
  assert.equal(toolCallErrored(false, notInCorpus), false)
})

test("a successful search result is not mistaken for a failure", () => {
  // Matching nothing is a valid answer, not an error — the zero_result block
  // explains it, and the call still succeeded.
  const zero = {
    content: JSON.stringify({
      source: "catalogue",
      total: 0,
      added: 0,
      zero_result: { meaning: "…", next_step: "…" },
    }),
  }
  assert.equal(toolCallErrored(false, zero), false)

  const hits = { content: JSON.stringify({ source: "catalogue", total: 111, added: 50 }) }
  assert.equal(toolCallErrored(false, hits), false)
})

test("the BnF MCP soft-failure envelope still counts as a failure", () => {
  // start_record past total — the payload that used to crash the handler.
  const soft = {
    content: JSON.stringify({
      success: false,
      error: "HTTP 500",
      status_code: 500,
      context: "bnf_search_catalogue",
    }),
  }
  assert.equal(toolCallErrored(false, soft), true)
})
