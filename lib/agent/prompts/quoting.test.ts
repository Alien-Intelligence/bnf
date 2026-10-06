// lib/agent/prompts/quoting.test.ts
// The quoting rules reach every prompt that quotes (Track C Phase 4): the
// research section in both locales and under both OCR-correction conventions,
// the corpus STYLE bullet, the research sub-agent's deposit — and not the
// corpus sub-agent, which stages ARKs and quotes nothing — and the note write
// tools' descriptions.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { Prisma, type Project } from "@/lib/generated/prisma/client"
import { OCR_CORRECTION_MARKING } from "@/lib/constants"
import { noteAppendTool, noteCreateTool, noteUpdateTool } from "@/lib/agent/tools/note"
import { OCR_CORRECTION_MARKING_MODE } from "@/models/notes/schema"
import { MEMORY_SCOPE } from "@/models/memory/schema"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import { renderCorpusPrompt } from "./corpus"
import { CORPUS_QUOTING_RULE, renderNoteQuoteHint, renderQuotingRules, SUBAGENT_QUOTING_RULE } from "./quoting"
import { renderResearchPrompt } from "./research"
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

const EMPTY = { sections: [] }

function research(locale: "fr" | "en"): string {
  return renderResearchPrompt(
    project,
    EMPTY,
    { scope: MEMORY_SCOPE.CORPUS, snapshot: EMPTY },
    { ingested: true, seq: 1, total: 3 },
    locale,
  )
}

for (const locale of ["fr", "en"] as const) {
  test(`the ${locale} research prompt carries the quoting rules`, () => {
    const p = research(locale)
    assert.ok(p.includes("## CITER LE TEXTE D'UN DOCUMENT — À LA LETTRE"))
    assert.ok(p.includes("Ne relie **jamais** par `[…]` deux paragraphes"))
    assert.ok(p.includes("**Deux coupures au plus**"))
    assert.ok(p.includes("[illisible]"))
    assert.ok(p.includes("`ocrLow: true`"))
    assert.ok(p.includes("Signale chaque mot corrigé en l'écrivant **entre crochets**"))
    // Between « RÉDIGER DES NOTES » and « DÉLÉGUER… ».
    const at = p.indexOf("## CITER LE TEXTE")
    assert.ok(p.indexOf("## RÉDIGER DES NOTES") < at && at < p.indexOf("## DÉLÉGUER"))
  })
}

test("the research prompt's interdictions forbid a reconstructed quote and a cross-passage […]", () => {
  const p = research("fr")
  const interdictions = p.slice(p.indexOf("## INTERDICTIONS ABSOLUES"), p.indexOf("## STYLE"))
  assert.match(interdictions, /Présenter entre guillemets ou en bloc de citation un texte qui n'est pas, mot pour mot/)
  assert.match(interdictions, /Relier par `\[…\]` des extraits de paragraphes, de folios ou de sections différents/)
  assert.match(p, /blockquote pour une citation clé \(recopiée à la lettre/)
  assert.doesNotMatch(p, /blockquote pour les citations clés/)
})

test("the research prompt treats a passage's char range as optional", () => {
  const p = research("fr")
  assert.match(p, /quand le passage en porte une \(`charRange`\), sa plage de caractères/)
  assert.doesNotMatch(p, /et la plage de caractères d'un passage/)
})

test("under SILENT the rule is the silent one and no word is bracketed", () => {
  const silent = renderQuotingRules(OCR_CORRECTION_MARKING_MODE.SILENT)
  assert.match(silent, /Écris le mot corrigé directement, sans le signaler/)
  assert.doesNotMatch(silent, /\[maison\]/)
  assert.match(renderNoteQuoteHint(OCR_CORRECTION_MARKING_MODE.SILENT), /Do not bracket corrected words\./)
})

test("the corpus prompt carries its quoting bullet in STYLE", () => {
  const p = renderCorpusPrompt(
    project,
    EMPTY,
    { scope: MEMORY_SCOPE.RESEARCH, snapshot: EMPTY },
    { versionSeq: 1, total: 0, facets: { type: {}, lang: {}, period: {} } },
    "fr",
  )
  assert.ok(p.slice(p.indexOf("## STYLE")).includes(CORPUS_QUOTING_RULE))
})

test("only the research sub-agent is told how to quote", () => {
  assert.ok(buildSubagentDirective(SESSION_SCOPE.RESEARCH, "t").includes(SUBAGENT_QUOTING_RULE))
  assert.ok(!buildSubagentDirective(SESSION_SCOPE.CORPUS, "t").includes(SUBAGENT_QUOTING_RULE))
})

test("every note write tool ends its description with the quote hint", () => {
  const hint = renderNoteQuoteHint(OCR_CORRECTION_MARKING)
  for (const tool of [noteCreateTool, noteUpdateTool, noteAppendTool]) {
    assert.ok(tool.description.endsWith(hint), `${tool.name} ends with the hint`)
  }
  assert.match(noteUpdateTool.description, /Use this to CORRECT or remove existing text/)
})
