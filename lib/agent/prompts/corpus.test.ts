// lib/agent/prompts/corpus.test.ts
// The corpus prompt makes the buffer THE path for any set of results, teaches
// `collapsing: false` for the press, forbids raw bnf__bnf_search_* with its
// cost, and requires a re-read before reporting a total (Track E Phase 13).
// 0.18.1 called the buffer « pas une étape obligatoire » and steered issues
// through `corpus.add` — which is how session (a) stored nothing to filter.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { Prisma, type Project } from "@/lib/generated/prisma/client"
import { renderCorpusPrompt } from "./corpus"
import { BNF_PERIODICAL_GUIDE } from "./bnf-knowledge"
import { buildSubagentDirective } from "./subagent"

const project: Project = {
  id: "p",
  ownerId: "u",
  name: "Incendies 1937",
  subtitle: null,
  isPublic: false,
  headVersionId: null,
  ingestedVersionId: null,
  clusterDatasetId: null,
  paidOcrEnabled: true,
  paidOcrBudgetUsd: null,
  paidOcrSpentUsd: new Prisma.Decimal(0),
  corpusSourceId: null,
  corpusSourceShareId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

function prompt(): string {
  return renderCorpusPrompt(
    project,
    { sections: [] },
    { scope: "research", snapshot: { sections: [] } },
    { versionSeq: 1, total: 0, facets: { type: {}, lang: {}, period: {} } },
    "fr",
  )
}

test("the corpus prompt teaches the press lane, the re-read and the explained counts", () => {
  const p = prompt()
  assert.match(p, /collapsing: false/)
  assert.match(p, /relis l'état AVANT d'annoncer un total/)
  assert.match(p, /alreadyInCorpus/)
  assert.match(p, /C'est LE chemin de tout ensemble de résultats/)
  assert.match(p, /N'utilise JAMAIS `bnf__bnf_search_catalogue` ni `bnf__bnf_search_gallica`/)
  assert.match(p, /notUnknown/)
  assert.match(p, /Ne lui donne jamais `bnf__bnf_search_\*` dans `tool_allowlist`/)
})

test("the old steering is gone", () => {
  const p = prompt()
  assert.doesNotMatch(p, /pas une étape obligatoire/)
  assert.doesNotMatch(p, /Deux voies, selon le besoin/)
  assert.doesNotMatch(BNF_PERIODICAL_GUIDE, /fais \*\*un seul\*\* `corpus\.add`/)
})

test("the corpus sub-agent sweeps only through corpus_search and reports tool numbers", () => {
  const d = buildSubagentDirective("corpus", "balaie 1937")
  assert.match(d, /N'utilise JAMAIS `bnf__bnf_search_\*`/)
  assert.match(d, /collapsing: false/)
  assert.match(d, /jamais une estimation/)
  assert.match(d, /NE VALIDE PAS le corpus/)
})

test("no guide tells the agent to call a raw bnf__bnf_search_* tool — only the ban names them", () => {
  const p = prompt()
  for (const tool of ["bnf__bnf_search_gallica", "bnf__bnf_search_catalogue"]) {
    const mentions = p.split(`\`${tool}\``).length - 1
    assert.equal(mentions, 1, `${tool} is named once, in the ban, not as an instruction (got ${mentions})`)
  }
  assert.match(p, /Trouve-le via `corpus_search` \(`source: "catalogue"`/)
})
