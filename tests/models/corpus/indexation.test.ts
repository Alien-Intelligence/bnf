// models/corpus/indexation.test.ts
// The indexation outcome, end to end against the real dev Postgres.
//
// classifyOutcome() (TypeScript, drives the row badge) and outcomeWhere()
// (Prisma, drives the filter and the counts) are two implementations of one
// rule. Everything here exists to catch them drifting apart: a corpus where the
// badge says « échec » and the « en échec » filter returns nothing is worse than
// no marking at all, because it teaches the librarian to distrust the mark.
//
// The mutual-exclusivity assertion is the load-bearing one. The four counts in
// CorpusSnapshot.indexation are four independent SQL predicates, and the header
// tile adds three of them up — if they ever overlap or leave a gap, that tile
// silently misreports how much of the corpus is missing from the index.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import type { User } from "@/lib/generated/prisma/client"
import { CorpusQueries } from "@/models/corpus/queries"
import {
  INDEXATION_OUTCOME,
  classifyOutcome,
} from "@/models/documents/schema"
import { createTestUser, createTestProject, deleteTestUser } from "@/lib/testing/fixtures"
import { seedCorpusDocuments } from "@/lib/testing/seed-corpus"
import { cleanupProject } from "@/lib/testing/project-cleanup"

let owner: User
let projectId: string

/**
 * One document per outcome, plus the two rows that have historically been
 * classified inconsistently between the classifier and the SQL mirror.
 *
 * `ark` suffixes are meaningful — bpt6k is Gallica (digitized), cb is a
 * catalogue notice (never digitized), matching sourceFromArk().
 */
const DOCS = [
  {
    ark: "ark:/12148/bpt6k900001",
    label: "indexed",
    expect: INDEXATION_OUTCOME.INDEXED,
    data: {
      indexedAt: new Date("2026-09-01T00:00:00Z"),
      indexError: null,
      docType: "book",
      ocrAvailable: true,
      iiifManifestUrl: "https://gallica.bnf.fr/iiif/ark:/12148/bpt6k900001/manifest.json",
      resolveStatus: "resolved",
    },
  },
  {
    ark: "ark:/12148/bpt6k900002",
    label: "indexed despite a warning",
    expect: INDEXATION_OUTCOME.INDEXED,
    data: {
      indexedAt: new Date("2026-09-01T00:00:00Z"),
      indexError: "page-fail-ratio 1/40 > 0.02",
      docType: "book",
      ocrAvailable: true,
      iiifManifestUrl: "https://gallica.bnf.fr/iiif/ark:/12148/bpt6k900002/manifest.json",
      resolveStatus: "resolved",
    },
  },
  {
    ark: "ark:/12148/bpt6k900003",
    label: "failed",
    expect: INDEXATION_OUTCOME.FAILED,
    data: {
      indexedAt: null,
      indexError: "rate_limited",
      docType: "book",
      ocrAvailable: true,
      iiifManifestUrl: "https://gallica.bnf.fr/iiif/ark:/12148/bpt6k900003/manifest.json",
      resolveStatus: "resolved",
    },
  },
  {
    ark: "ark:/12148/cb900004",
    label: "excluded — a catalogue notice, never digitized",
    expect: INDEXATION_OUTCOME.EXCLUDED,
    data: {
      indexedAt: null,
      indexError: null,
      docType: "book",
      ocrAvailable: null,
      iiifManifestUrl: null,
      resolveStatus: "resolved",
    },
  },
  {
    ark: "ark:/12148/bpt6k900005",
    label: "excluded — digitized, resolved, no text layer",
    expect: INDEXATION_OUTCOME.EXCLUDED,
    data: {
      indexedAt: null,
      indexError: null,
      docType: "book",
      ocrAvailable: false,
      iiifManifestUrl: "https://gallica.bnf.fr/iiif/ark:/12148/bpt6k900005/manifest.json",
      resolveStatus: "resolved",
    },
  },
  {
    // The regression this file was extended for. `notIn` compiles to SQL NOT IN,
    // which does not match a NULL doc_type, while classifyIngestion() calls a
    // null type sans_texte. Before the fix this row was `excluded` on the badge
    // and `not_ingested` to every query — one document, two answers.
    ark: "ark:/12148/bpt6k900006",
    label: "excluded — digitized, resolved, no text layer, NULL doc_type",
    expect: INDEXATION_OUTCOME.EXCLUDED,
    data: {
      indexedAt: null,
      indexError: null,
      docType: null,
      ocrAvailable: false,
      iiifManifestUrl: "https://gallica.bnf.fr/iiif/ark:/12148/bpt6k900006/manifest.json",
      resolveStatus: "resolved",
    },
  },
  {
    ark: "ark:/12148/bpt6k900007",
    label: "not_ingested — ingestable, no run has covered it",
    expect: INDEXATION_OUTCOME.NOT_INGESTED,
    data: {
      indexedAt: null,
      indexError: null,
      docType: "book",
      ocrAvailable: true,
      iiifManifestUrl: "https://gallica.bnf.fr/iiif/ark:/12148/bpt6k900007/manifest.json",
      resolveStatus: "resolved",
    },
  },
  {
    // A pending stub must never read as `excluded`: the BnF lookup has not come
    // back, so "this can never be indexed" is a claim we cannot make yet.
    ark: "ark:/12148/bpt6k900008",
    label: "not_ingested — digitized stub, still resolving",
    expect: INDEXATION_OUTCOME.NOT_INGESTED,
    data: {
      indexedAt: null,
      indexError: null,
      docType: null,
      ocrAvailable: null,
      iiifManifestUrl: "https://gallica.bnf.fr/iiif/ark:/12148/bpt6k900008/manifest.json",
      resolveStatus: "pending",
    },
  },
] as const

const EXPECTED_COUNTS = {
  indexed: 2,
  failed: 1,
  excluded: 3,
  notIngested: 2,
}

before(async () => {
  owner = await createTestUser()
  projectId = (await createTestProject(owner.id, "indexation")).id

  // Seeded via the shared test helper, which routes the membership write
  // through advanceVersion() like the real add path — writing corpus_membership
  // against the existing head directly is forbidden (corpus-versioning.md) and
  // would build every assertion below on a state the app can never produce.
  // The ingest lifecycle is skipped deliberately: reproducing a whole run per
  // case would test the worker rather than the classification of its outcome.
  await seedCorpusDocuments(
    projectId,
    DOCS.map((d) => ({ ark: d.ark, ...d.data })),
    `user:${owner.id}`,
  )
})

after(async () => {
  await cleanupProject(projectId)
  await deleteTestUser(owner.id)
})

test("the SQL filter agrees with the classifier on every row", async () => {
  for (const doc of DOCS) {
    const page = await CorpusQueries.list(projectId, "head", {
      filters: { outcome: [doc.expect] },
      limit: 100,
    })
    const arks = page.documents.map((d) => d.ark)
    assert.ok(
      arks.includes(doc.ark),
      `${doc.label}: classifier says ${doc.expect}, the ${doc.expect} filter does not return it`,
    )

    // And the classifier, run over the row the query layer actually returns.
    const row = page.documents.find((d) => d.ark === doc.ark)
    assert.ok(row, `${doc.label}: row missing`)
    assert.equal(
      classifyOutcome({
        indexedAt: row.indexedAt,
        indexError: row.indexError,
        docType: row.docType,
        ocrAvailable: row.ocrAvailable,
        digitized: Boolean(row.iiifManifestUrl),
        resolveStatus: row.resolveStatus,
      }),
      doc.expect,
      doc.label,
    )
  }
})

test("no document matches two outcomes", async () => {
  const seen = new Map<string, string>()
  for (const outcome of Object.values(INDEXATION_OUTCOME)) {
    const page = await CorpusQueries.list(projectId, "head", {
      filters: { outcome: [outcome] },
      limit: 100,
    })
    for (const d of page.documents) {
      const already = seen.get(d.ark)
      assert.equal(
        already,
        undefined,
        `${d.ark} matched both ${already} and ${outcome}`,
      )
      seen.set(d.ark, outcome)
    }
  }
  assert.equal(seen.size, DOCS.length, "a document matched no outcome at all")
})

test("the snapshot counts match, and sum to the corpus size", async () => {
  const snap = await CorpusQueries.snapshot(projectId, "head", { limit: 0 })
  assert.deepEqual(snap.indexation, EXPECTED_COUNTS)

  const sum =
    snap.indexation.indexed +
    snap.indexation.failed +
    snap.indexation.excluded +
    snap.indexation.notIngested
  assert.equal(sum, snap.total, "the four buckets do not partition the corpus")
})

test("an active outcome filter does not collapse the other buckets", async () => {
  // The header tile reads these counts while the filter is on. If they narrowed
  // with it, selecting « en échec » would report zero failures — the filter
  // would erase the very number that prompted the click.
  const snap = await CorpusQueries.snapshot(projectId, "head", {
    limit: 0,
    filters: { outcome: [INDEXATION_OUTCOME.FAILED] },
  })
  assert.deepEqual(snap.indexation, EXPECTED_COUNTS)
  assert.equal(snap.total, EXPECTED_COUNTS.failed, "total should follow the filter")
})

test("selecting several outcomes returns their union", async () => {
  const page = await CorpusQueries.list(projectId, "head", {
    filters: {
      outcome: [INDEXATION_OUTCOME.FAILED, INDEXATION_OUTCOME.NOT_INGESTED],
    },
    limit: 100,
  })
  assert.equal(
    page.total,
    EXPECTED_COUNTS.failed + EXPECTED_COUNTS.notIngested,
  )
})
