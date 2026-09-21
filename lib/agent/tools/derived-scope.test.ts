// lib/agent/tools/derived-scope.test.ts
// The tool-boundary half of read-only corpus consumption (plan §5.5 layer 2).
// A derived project must never own a corpus-scope session, and its research
// tools must target the SOURCE's dataset while its notes stay local. These are
// in-process assertions over the policy and the tool context — no LLM, no
// cluster — so a regression is caught in milliseconds.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionPolicy } from "@/models/sessions/policy"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import { CorpusPolicy } from "@/models/corpus/policy"
import { BufferPolicy } from "@/models/buffer/policy"
import { IngestPolicy } from "@/models/ingest/policy"
import { ProjectPolicy } from "@/models/projects/policy"
import { PROJECT_ACCESS } from "@/lib/authz/project-access"
import {
  CORPUS_ACCESS_REVOKED_ERROR,
  resolveIngestedCorpus,
} from "./ingestion-guard"
import { toolsForScope } from "./index"
import type { PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"

const GROUP = "group-a"

const user: PolicyUser = {
  id: "reader",
  email: "reader@example.test",
  emailVerified: true,
  name: "reader",
  image: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  role: "member",
  alienUserId: null,
  groupIds: [GROUP],
}

function project(over: Partial<ProjectWithShares> = {}): ProjectWithShares {
  return {
    id: "derived-1",
    ownerId: user.id,
    name: "Espace de recherche",
    subtitle: null,
    isPublic: false,
    headVersionId: null,
    ingestedVersionId: null,
    clusterDatasetId: null,
    paidOcrEnabled: true,
    paidOcrBudgetUsd: null,
    paidOcrSpentUsd: null as never,
    corpusSourceId: "source-1",
    corpusSourceShareId: "share-1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    shares: [],
    ...over,
  }
}

// --- a derived project owns no corpus session ------------------------------

test("a derived project's OWNER may not create a corpus session", () => {
  const policy = new SessionPolicy(user)
  const derived = project()

  assert.equal(
    policy.create({ project: derived, scope: SESSION_SCOPE.CORPUS }),
    false,
    "a corpus session would carry the buffer and ingest tools",
  )
  assert.equal(
    policy.create({ project: derived, scope: SESSION_SCOPE.RESEARCH }),
    true,
    "research sessions are exactly what a derived workspace is for",
  )
})

test("a normal project's owner may create either scope", () => {
  const policy = new SessionPolicy(user)
  const own = project({ corpusSourceId: null, corpusSourceShareId: null })

  assert.equal(policy.create({ project: own, scope: SESSION_SCOPE.CORPUS }), true)
  assert.equal(policy.create({ project: own, scope: SESSION_SCOPE.RESEARCH }), true)
})

// --- the corpus/buffer/ingest write policies all refuse --------------------

test("every corpus-mutating policy refuses a derived project, owner included", () => {
  const derived = project()

  assert.equal(new CorpusPolicy(user).mutate(derived), false, "corpus")
  assert.equal(new BufferPolicy(user).mutate(derived), false, "buffer")
  assert.equal(new IngestPolicy(user).submit(derived), false, "ingest submit")
  assert.equal(new IngestPolicy(user).cancel(derived), false, "ingest cancel")

  // …while reading follows the ordinary access rules.
  assert.equal(new CorpusPolicy(user).read(derived), true)
  assert.equal(new IngestPolicy(user).view(derived), true)
})

test("a derived project's OWNER may not re-share it", () => {
  // The escalation this closes: the reader owns the workspace but not the
  // corpus it reads. If sharing were allowed, its members would reach the
  // SOURCE's corpus through `corpusProjectId()` — the read gate gives them the
  // workspace's pinned share, never a check against the source's owner. A
  // read-only grant would become an onward grant of someone else's data.
  assert.equal(new ProjectPolicy(user).share(project()), false)

  // An ordinary project the same user owns is of course still shareable, so
  // this refuses the derivation, not the user.
  assert.equal(
    new ProjectPolicy(user).share(project({ corpusSourceId: null, corpusSourceShareId: null })),
    true,
  )
})

test("not even an admin may re-share a derived project", () => {
  // Admin resolves to `owner` everywhere else. It must not be the way round
  // the rule above: the corpus still is not theirs to give.
  const admin: PolicyUser = { ...user, id: "admin-1", role: "admin" }

  assert.equal(new ProjectPolicy(admin).share(project()), false)
  assert.equal(
    new ProjectPolicy(admin).share(project({ corpusSourceId: null, corpusSourceShareId: null })),
    true,
  )
})

test("a write share does not let a member mutate a derived project's corpus", () => {
  const notOwner = { ...user, id: "someone-else" }
  const derived = project({
    ownerId: "reader",
    shares: [{ id: "s", groupId: GROUP, access: PROJECT_ACCESS.WRITE }],
  })

  assert.equal(new CorpusPolicy(notOwner).mutate(derived), false)
})

// --- the research tool registry ---------------------------------------------

test("the research scope carries no corpus, buffer or ingest tools", () => {
  // A derived project only ever runs research sessions (see above), so the
  // research registry is the complete set of tools it can reach.
  const names = toolsForScope("research").map((t) => t.name)
  const leaked = names.filter(
    (n) =>
      n.startsWith("buffer_") ||
      n.startsWith("corpus_") ||
      n.startsWith("ingest"),
  )
  assert.deepEqual(leaked, [], `corpus-side tools in research scope: ${leaked}`)
})

// --- the revoked grant is a structured tool result, never a throw ------------

test("a revoked grant yields the revoked error without touching the database", async () => {
  const result = await resolveIngestedCorpus(
    { corpusProjectId: "source-1", corpusReachable: false },
    "not ingested",
  )

  assert.deepEqual(result, { error: CORPUS_ACCESS_REVOKED_ERROR })
})

test("the revoked error is distinct from the not-ingested one", async () => {
  // The two invite different actions: one the researcher can take, one only
  // the corpus owner can. Collapsing them would send them to a dead end.
  const NOT_INGESTED = "not ingested"
  const revoked = await resolveIngestedCorpus(
    { corpusProjectId: "source-1", corpusReachable: false },
    NOT_INGESTED,
  )

  assert.notEqual(
    "error" in revoked ? revoked.error : null,
    NOT_INGESTED,
  )
})
