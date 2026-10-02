// lib/agent/prompts/revision.test.ts
// The prompt-text fingerprint. AppSession caches its rendered system prompt and
// serves it only at the current PROMPT_REVISION (lib/agent/prompts/builder.ts),
// so a prompt-text change reaches existing sessions ONLY if the revision is
// bumped. This test renders the four prompts (corpus/research × fr/en) from
// fixed fixtures and pins their sha256 against PROMPT_REVISION: any change to
// lib/agent/prompts/* fails it until the revision is bumped and the
// fingerprints below are updated — in the same commit as the prompt change.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { Prisma, type Project } from "@/lib/generated/prisma/client"
import { PROMPT_REVISION } from "@/lib/constants"
import { renderCorpusPrompt } from "./corpus"
import { renderResearchPrompt } from "./research"
import type { MemorySnapshot } from "./shared"

/** The revision the fingerprints below were recorded at. */
const RECORDED_REVISION = "2026-10-01.corpus-buffer-v2"

const RECORDED: Record<string, string> = {
  "corpus.fr": "6438f2ba2d0d5ca59e837994efff8bc239ca4b75bbb49388f0544bcdc2be1f46",
  "corpus.en": "71cb2bcd972382f530b96690e43d16eb86cbcf663fbc46d78ce8060aef18097c",
  "research.fr": "964dcd3e43cb8a3fc159579cc16c1367873ae3ad5b820a9f2cf5f42168688bb4",
  "research.en": "5784f4b183ea3cceb6d50773ef9d343ae91783b2bba5d696fd906a43494dc9dc",
}

const project: Project = {
  id: "fingerprint",
  ownerId: "owner",
  name: "Projet témoin",
  subtitle: "Empreinte des prompts",
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

const memory = (text: string): MemorySnapshot => ({
  sections: [{ title: "Périmètre", items: [{ id: "m1", text, origin: "consigne" }] }],
})

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function fingerprints(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const locale of ["fr", "en"] as const) {
    out[`corpus.${locale}`] = sha256(
      renderCorpusPrompt(
        project,
        memory("Presse française, 1937."),
        { scope: "research", snapshot: memory("Source à risque : bpt6k1.") },
        { versionSeq: 3, total: 12, facets: { type: { press: 12 }, lang: { fr: 12 }, period: { "1930s": 12 } } },
        locale,
      ),
    )
    out[`research.${locale}`] = sha256(
      renderResearchPrompt(
        project,
        memory("Question : la réception des incendies de 1937."),
        { scope: "corpus", snapshot: memory("Presse française, 1937.") },
        { ingested: true, seq: 3, total: 12 },
        locale,
      ),
    )
  }
  return out
}

test("the rendered prompts match the fingerprints recorded at PROMPT_REVISION", () => {
  const actual = fingerprints()
  assert.equal(
    RECORDED_REVISION,
    PROMPT_REVISION,
    "PROMPT_REVISION was bumped: re-record the fingerprints below at the new revision",
  )
  assert.deepEqual(
    actual,
    RECORDED,
    "A prompt changed. Bump PROMPT_REVISION (lib/constants.ts) so existing sessions re-render it, " +
      `then record these fingerprints: ${JSON.stringify(actual)}`,
  )
})

test("rendering is deterministic (a fingerprint can only move with the text)", () => {
  assert.deepEqual(fingerprints(), fingerprints())
})
