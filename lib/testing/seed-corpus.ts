// lib/testing/seed-corpus.ts
// Puts a set of documents into a project's corpus WITHOUT going through
// CorpusService.addArks, for fixtures that need documents with specific column
// state as a precondition rather than as the thing under test.
//
// Test-only: never call this from app code.
//
// Why it exists rather than a bare `prisma.corpusMembership.create`:
// playbook/corpus-versioning.md forbids writing membership rows against an
// existing version, because a version is sealed and its membership is what
// makes a corpus reproducible — a fixture that mutates one in place produces a
// state the application can never reach, so anything built on it is subtly
// unlike production. This routes through `advanceVersion()`, the single
// creator of CorpusVersion/CorpusMembership state, under the same per-project
// advisory lock and with the same dedup and idempotency the real add path
// applies.
//
// Why not CorpusService.addArks: it inserts pending stubs and its caller then
// kicks background metadata resolution and cb→Gallica canonicalization against
// the live BnF. A test that only cares what a document's columns classify as
// should be neither network-bound nor charged to the BnF quota.
//
// What a corpus seeded here therefore does NOT have, all of which the real add
// path would produce — check this list before reusing the helper for a fixture
// that depends on any of them:
//
//   • CorpusContribution rows. addArks records per-session attribution when
//     given a sessionId (service.ts, after the advance). The `session` corpus
//     filter reads those rows, so it matches nothing against this fixture.
//   • canonicalStatus = "pending" on `cb…` notices. addArks stamps it under
//     `{ canonicalize: true }` so the background canonicalizer picks them up;
//     a notice seeded here stays unstamped.
//   • Resolved BnF metadata. Rows carry exactly the columns the caller passes,
//     which is the point — but `resolveStatus` is whatever was supplied, not
//     the product of a real lookup.
//
// Neither of the first two is a BnF round-trip: both are local writes, and
// calling them part of the network skip would be the kind of not-quite-true
// comment that makes the next reader trust a fixture further than they should.
import "server-only"

import { prisma } from "@/lib/db"
import type { Prisma } from "@/lib/generated/prisma/client"
import { CorpusQueries } from "@/models/corpus/queries"
import { advanceVersion } from "@/models/corpus/versioning"

/** A document to seed: its ARK plus whatever column state the fixture needs. */
export type SeedDocument = {
  ark: string
} & Omit<Prisma.DocumentUncheckedCreateInput, "ark" | "projectId">

/**
 * Create `docs` as Document rows and advance the project's head version to
 * include them. Returns the seq of the new head.
 *
 * `createdBy` takes the same stable actor format the real mutation path uses —
 * `user:<uid>` or `agent:session:<sid>` (corpus-versioning.md). It is a
 * persisted, queryable identity on corpus_version, so a fixture inventing a
 * third shape would break every reader entitled to parse those two.
 *
 * Throws if the project has no head version — every project has one
 * (corpus-versioning.md invariant 1), so its absence means a malformed fixture,
 * and seeding into nothing would fail later in a way that hides the cause.
 */
export async function seedCorpusDocuments(
  projectId: string,
  docs: readonly SeedDocument[],
  createdBy: string,
): Promise<number> {
  // `skipDuplicates`, as DocumentService.createStubs does: a Document row lives
  // forever and membership is what decides visibility, so seeding an ARK the
  // project has already touched must be a no-op here rather than a unique
  // violation on (projectId, ark).
  await prisma.document.createMany({
    data: docs.map((d) => ({ ...d, projectId })),
    skipDuplicates: true,
  })

  return prisma.$transaction(async (tx) => {
    // The per-project advisory lock, for the same reason CorpusService.addArks
    // takes it (corpus-versioning.md invariant 6): head is read and a new
    // version written inside one transaction, and without the lock two fixtures
    // seeding the same project concurrently can both read the same head and
    // race on `seq`. Cheap here, and it keeps this helper an actual mirror of
    // the real path rather than one that only claims to be.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`project:${projectId}`}))`

    // Dedupe and subtract what head already holds, as CorpusService.addArks
    // does: advanceVersion's delta is contracted to ARKs NOT already in the
    // parent, and handing it a duplicate surfaces as an opaque composite-PK
    // violation on corpus_membership rather than a legible test failure.
    const head = await CorpusQueries.headVersion(projectId)
    const members = new Set(head.membership.map((m) => m.ark))
    const addArks = [...new Set(docs.map((d) => d.ark))].filter(
      (a) => !members.has(a),
    )

    const version = await advanceVersion(tx, projectId, head, {
      addArks,
      removeArks: [],
      createdBy,
      note: "test fixture",
    })
    return version.seq
  })
}
