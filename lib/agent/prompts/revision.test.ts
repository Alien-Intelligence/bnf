// lib/agent/prompts/revision.test.ts
// The prompt-text fingerprint. AppSession caches its rendered system prompt and
// serves it only at the current PROMPT_REVISION (lib/agent/prompts/builder.ts),
// so a prompt-text change reaches existing sessions ONLY if the revision moves
// (found bug B5).
//
// Every prompt branch is rendered from fixed fixtures — corpus and research,
// fr and en, with an empty corpus, a corpus never ingested, a derived source
// granted and revoked, empty memories, and a cross-scope memory past its cap —
// and the sha256 of each is recorded in FINGERPRINT_HISTORY under the revision
// it ships at. The history is append-only and SEALED: each revision string ends
// with the first SEAL_LENGTH hex digits of the sha256 of its own fingerprints.
// So:
//   - a prompt change fails the test until a NEW revision is recorded;
//   - pasting new fingerprints under an EXISTING revision fails too (the seal
//     no longer matches its key) — the only way to green is a new revision
//     string, i.e. the bump that makes existing sessions re-render.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { Prisma, type Project } from "@/lib/generated/prisma/client"
import { CORPUS_SOURCE_STATE } from "@/lib/authz/corpus-source"
import { MEMORY_CROSS_SCOPE_MAX_ITEMS, PROMPT_REVISION } from "@/lib/constants"
import { MEMORY_ORIGIN, MEMORY_SCOPE } from "@/models/memory/schema"
import { renderCorpusPrompt } from "./corpus"
import { renderResearchPrompt } from "./research"
import type { MemorySnapshot } from "./shared"

const SEAL_LENGTH = 12

/**
 * Revision → the fingerprints of every rendered branch at that revision, in
 * the order the revisions shipped. NEVER edit an entry: add a new one (with a
 * new date/label and the seal the failure message prints) and set
 * PROMPT_REVISION (lib/constants.ts) to it, in the same commit as the prompt
 * change.
 */
const FINGERPRINT_HISTORY: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
  [
    "2026-10-02.corpus-buffer-v2.6afc4a2fa3c7",
    {
      "corpus.base.fr": "6fd680b769e68d2d0269e4faf4cca0b7101ff3aeffb60b1919dfae74c0c2a5ec",
      "corpus.empty-corpus.fr": "c3e7ec18e10658504321354037d2543b6f34d856de2e865c27a14facb71c5a68",
      "corpus.empty-memory.fr": "16bffde31bfd7efebab8dbcbe810266ea7bf5c244aab5166ce8c5a5bb23d50e7",
      "corpus.over-cap.fr": "dc643eaeb70592a9def2246804754779653de5329e0836e008f9230c4b17cc11",
      "research.base.fr": "6af47f43d2a47aa4a85f40955d6c41d2bc1af512f69963bef67c545131bfded9",
      "research.not-ingested.fr": "71b428cfdd15f0b294335a9184eaacf400df432028f34d154ff17fb1a05337a9",
      "research.derived-shared.fr": "f0f570eb233352fb5843b27063625cc4098e574f8a844cb81934c7b70d8d6c15",
      "research.derived-shared-not-ingested.fr": "7be5c47149ef72bf9576442807e284c93abf25e2bdd3d30a3841795d98254556",
      "research.derived-revoked.fr": "c4e9748416aadfd4d4df7244ac359e89e807a53d09069545c38ad7eda5262f99",
      "research.empty-memory.fr": "305f835b109d95b3056743a6ea48cff93bc238120749eac7fb0ca2c1ad1297de",
      "research.over-cap.fr": "dc688a5f04537189888b47f2dac5829b38c03053d55edd8c22544d5d93fa3197",
      "corpus.base.en": "55c7bfed8a9817559b864600787501dbe7d9c2c551fac2e8bd249f983860b1ca",
      "corpus.empty-corpus.en": "5d69dca7a98b2e19c3438e91684b1763219ac77fd9b175b3863f02b6cf19f3db",
      "corpus.empty-memory.en": "86ba5f42207d37250ae3876de4f81434e1f7e5ab26d073bb269d7362b22541ac",
      "corpus.over-cap.en": "4ed431e2a6a753d3f6d0f6e88c9112854f6b51d6a3dd216311cdba62d8c965f4",
      "research.base.en": "76e50f22014ca5a8129edec5afb323b806769f10a98839520927bbcfc8c86cbc",
      "research.not-ingested.en": "4263b8973e3e58ea657d13682b2e7c33efdf014bb92a7899b53df149ae733d9a",
      "research.derived-shared.en": "20489e4c3b1c9c03d8fa4f93c32756acc10237d83335ea9c4a592a56e6c04f8b",
      "research.derived-shared-not-ingested.en": "100952b20966a2e362ffdc48c3bbf4c9d34e7fca2559e63e8f9d5683e305b2d2",
      "research.derived-revoked.en": "80ba029c2132e580551e7270bf2d89693c45fae80879668fa56e47702d2321bc",
      "research.empty-memory.en": "8ad7f06070d6c46c8dcb78c2ef00f6c007e0005a9e0564f9259babbe72d18257",
      "research.over-cap.en": "36a417b18462867d9865a618324037ba876f36aed908f2df48ab3b0c0b3e2d86",
    },
  ],
  [
    "2026-10-05.corpus-buffer-v2-not-rule.076905ddf460",
    {
      "corpus.base.fr": "ff9bffbb2c293ef11b5be2b681e13d3ca7e9767a03e7126dc4c11969f9ba0899",
      "corpus.empty-corpus.fr": "ac70dbbe5127fd085748f059e6ebc459121d431fdb6cd82bc48a4edd63b47ee3",
      "corpus.empty-memory.fr": "21f6348e0461b5a0b617bad8fe713ae8022c108c3e9323250b713fcf8b070f8a",
      "corpus.over-cap.fr": "453960583adab1897ddd9e8617a0c5f6b06f2e8d3a0fa9b8312b97babdaa8f28",
      "research.base.fr": "6af47f43d2a47aa4a85f40955d6c41d2bc1af512f69963bef67c545131bfded9",
      "research.not-ingested.fr": "71b428cfdd15f0b294335a9184eaacf400df432028f34d154ff17fb1a05337a9",
      "research.derived-shared.fr": "f0f570eb233352fb5843b27063625cc4098e574f8a844cb81934c7b70d8d6c15",
      "research.derived-shared-not-ingested.fr": "7be5c47149ef72bf9576442807e284c93abf25e2bdd3d30a3841795d98254556",
      "research.derived-revoked.fr": "c4e9748416aadfd4d4df7244ac359e89e807a53d09069545c38ad7eda5262f99",
      "research.empty-memory.fr": "305f835b109d95b3056743a6ea48cff93bc238120749eac7fb0ca2c1ad1297de",
      "research.over-cap.fr": "dc688a5f04537189888b47f2dac5829b38c03053d55edd8c22544d5d93fa3197",
      "corpus.base.en": "862c0c943dc7c18fb296404422751635875f104f2ff68545175857b7e3a1bf12",
      "corpus.empty-corpus.en": "67261eca81ae00394bbeb0a8a53466df9f89799a202ea5e250de064e88d3395b",
      "corpus.empty-memory.en": "e54a89dbc91471630f615050e72bdc5845ff97b137458c737bc286463dfeda3d",
      "corpus.over-cap.en": "90281f50a601793276eadada4cdcf9e21de0d35fb22cb517b8a1713157c45f45",
      "research.base.en": "76e50f22014ca5a8129edec5afb323b806769f10a98839520927bbcfc8c86cbc",
      "research.not-ingested.en": "4263b8973e3e58ea657d13682b2e7c33efdf014bb92a7899b53df149ae733d9a",
      "research.derived-shared.en": "20489e4c3b1c9c03d8fa4f93c32756acc10237d83335ea9c4a592a56e6c04f8b",
      "research.derived-shared-not-ingested.en": "100952b20966a2e362ffdc48c3bbf4c9d34e7fca2559e63e8f9d5683e305b2d2",
      "research.derived-revoked.en": "80ba029c2132e580551e7270bf2d89693c45fae80879668fa56e47702d2321bc",
      "research.empty-memory.en": "8ad7f06070d6c46c8dcb78c2ef00f6c007e0005a9e0564f9259babbe72d18257",
      "research.over-cap.en": "36a417b18462867d9865a618324037ba876f36aed908f2df48ab3b0c0b3e2d86",
    },
  ],
]
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
  sections: [{ title: "Périmètre", items: [{ id: "m1", text, origin: MEMORY_ORIGIN.CONSIGNE }] }],
})
const EMPTY_MEMORY: MemorySnapshot = { sections: [] }
const OVER_CAP_MEMORY: MemorySnapshot = {
  sections: [
    {
      title: "Lot",
      items: Array.from({ length: MEMORY_CROSS_SCOPE_MAX_ITEMS + 3 }, (_, i) => ({
        id: `m${i}`,
        text: `Fait de recherche numéro ${i}`,
        origin: MEMORY_ORIGIN.DEDUIT,
      })),
    },
  ],
}

const CORPUS = { versionSeq: 3, total: 12, facets: { type: { press: 12 }, lang: { fr: 12 }, period: { "1930s": 12 } } }
const EMPTY_CORPUS = { versionSeq: 0, total: 0, facets: { type: {}, lang: {}, period: {} } }
const INGESTED = { ingested: true, seq: 3, total: 12 } as const
const NOT_INGESTED = { ingested: false } as const
const SHARED_SOURCE = { name: "Corpus source", state: CORPUS_SOURCE_STATE.SHARED }
const REVOKED_SOURCE = { name: "Corpus source", state: CORPUS_SOURCE_STATE.REVOKED }

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/** Every prompt branch, by a stable key. */
function fingerprints(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const locale of ["fr", "en"] as const) {
    const own = memory("Presse française, 1937.")
    const researchCross = { scope: MEMORY_SCOPE.RESEARCH, snapshot: memory("Source à risque : bpt6k1.") }
    const corpusCross = { scope: MEMORY_SCOPE.CORPUS, snapshot: memory("Presse française, 1937.") }
    const corpus = (key: string, ...args: Parameters<typeof renderCorpusPrompt>) => {
      out[`corpus.${key}.${locale}`] = sha256(renderCorpusPrompt(...args))
    }
    const research = (key: string, ...args: Parameters<typeof renderResearchPrompt>) => {
      out[`research.${key}.${locale}`] = sha256(renderResearchPrompt(...args))
    }
    corpus("base", project, own, researchCross, CORPUS, locale)
    corpus("empty-corpus", project, own, researchCross, EMPTY_CORPUS, locale)
    corpus("empty-memory", project, EMPTY_MEMORY, { scope: MEMORY_SCOPE.RESEARCH, snapshot: EMPTY_MEMORY }, CORPUS, locale)
    corpus("over-cap", project, own, { scope: MEMORY_SCOPE.RESEARCH, snapshot: OVER_CAP_MEMORY }, CORPUS, locale)
    research("base", project, own, corpusCross, INGESTED, locale)
    research("not-ingested", project, own, corpusCross, NOT_INGESTED, locale)
    research("derived-shared", project, own, corpusCross, INGESTED, locale, SHARED_SOURCE)
    research("derived-shared-not-ingested", project, own, corpusCross, NOT_INGESTED, locale, SHARED_SOURCE)
    research("derived-revoked", project, own, corpusCross, NOT_INGESTED, locale, REVOKED_SOURCE)
    research("empty-memory", project, EMPTY_MEMORY, { scope: MEMORY_SCOPE.CORPUS, snapshot: EMPTY_MEMORY }, INGESTED, locale)
    research("over-cap", project, own, { scope: MEMORY_SCOPE.CORPUS, snapshot: OVER_CAP_MEMORY }, INGESTED, locale)
  }
  return out
}

/** The seal of a fingerprint set: order-independent, content-addressed. */
function seal(prints: Readonly<Record<string, string>>): string {
  const canonical = JSON.stringify(Object.keys(prints).sort().map((k) => [k, prints[k]]))
  return sha256(canonical).slice(0, SEAL_LENGTH)
}

test("every recorded revision is sealed by its own fingerprints (entries are never edited)", () => {
  for (const [revision, prints] of FINGERPRINT_HISTORY) {
    assert.ok(
      revision.endsWith(`.${seal(prints)}`),
      `The fingerprints recorded under ${revision} were changed after it was sealed. Restore them, ` +
        "and record the new prompt text under a NEW revision instead.",
    )
  }
  const revisions = FINGERPRINT_HISTORY.map(([r]) => r)
  assert.equal(new Set(revisions).size, revisions.length, "a revision is recorded twice")
})

test("PROMPT_REVISION is the latest recorded revision and matches the rendered prompts", () => {
  const actual = fingerprints()
  const latest = FINGERPRINT_HISTORY.at(-1)
  const proposal = `${new Date().toISOString().slice(0, 10)}.<label>.${seal(actual)}`
  assert.ok(
    latest !== undefined && latest[0] === PROMPT_REVISION,
    `PROMPT_REVISION (${PROMPT_REVISION}) must be the last entry of FINGERPRINT_HISTORY. ` +
      `To record the current prompts, append [${JSON.stringify(proposal)}, ${JSON.stringify(actual)}] ` +
      "and set PROMPT_REVISION to that revision.",
  )
  assert.deepEqual(
    actual,
    latest[1],
    "A prompt changed since PROMPT_REVISION was recorded. Do NOT edit that entry: append " +
      `[${JSON.stringify(proposal)}, ${JSON.stringify(actual)}] to FINGERPRINT_HISTORY and set ` +
      "PROMPT_REVISION (lib/constants.ts) to the new revision, so existing sessions re-render.",
  )
})

test("rendering is deterministic, and every branch renders a distinct prompt", () => {
  const prints = fingerprints()
  assert.deepEqual(prints, fingerprints())
  const byHash = new Map<string, string>()
  for (const [key, hash] of Object.entries(prints)) {
    assert.ok(!byHash.has(hash), `${key} renders the same prompt as ${byHash.get(hash)} — a branch is not exercised`)
    byHash.set(hash, key)
  }
})
