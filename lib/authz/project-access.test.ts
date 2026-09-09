// lib/authz/project-access.test.ts
// The exhaustive truth table for project authorization. This predicate is the
// security-critical unit of both Groups and read-only corpus consumption:
// every policy, page guard and route delegates to it, so a regression here is
// a regression everywhere. Pure functions — no DB, no fixtures.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  PROJECT_ACCESS,
  PROJECT_ACCESS_LEVEL,
  canReadProject,
  canWriteProject,
  isProjectOwner,
  isProjectAccess,
  projectAccessLevel,
} from "./project-access"
import type { PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"

const OWNER_ID = "user-owner"
const OTHER_ID = "user-other"
const GROUP_A = "group-a"
const GROUP_B = "group-b"

function user(
  overrides: Partial<PolicyUser> & Pick<PolicyUser, "id">,
): PolicyUser {
  return {
    email: `${overrides.id}@example.test`,
    emailVerified: true,
    name: overrides.id,
    image: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    role: "member",
    alienUserId: null,
    groupIds: [],
    ...overrides,
  }
}

function project(
  overrides: Partial<ProjectWithShares> = {},
): ProjectWithShares {
  return {
    id: "project-1",
    ownerId: OWNER_ID,
    name: "Corpus",
    subtitle: null,
    isPublic: false,
    headVersionId: null,
    ingestedVersionId: null,
    clusterDatasetId: null,
    paidOcrEnabled: true,
    paidOcrBudgetUsd: null,
    paidOcrSpentUsd: null as never,
    corpusSourceId: null,
    corpusSourceShareId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    shares: [],
    ...overrides,
  }
}

function share(groupId: string, access: string) {
  return { id: `share-${groupId}-${access}`, groupId, access }
}

// ---------------------------------------------------------------------------
// The truth table
// ---------------------------------------------------------------------------

const CASES: Array<{
  name: string
  user: PolicyUser
  project: ProjectWithShares
  level: string
}> = [
  {
    name: "the owner is owner, even on a project with no shares",
    user: user({ id: OWNER_ID }),
    project: project(),
    level: PROJECT_ACCESS_LEVEL.OWNER,
  },
  {
    name: "an admin resolves to owner on someone else's private project",
    user: user({ id: OTHER_ID, role: "admin" }),
    project: project(),
    level: PROJECT_ACCESS_LEVEL.OWNER,
  },
  {
    name: "a write share on one of the user's groups grants write",
    user: user({ id: OTHER_ID, groupIds: [GROUP_A] }),
    project: project({ shares: [share(GROUP_A, PROJECT_ACCESS.WRITE)] }),
    level: PROJECT_ACCESS_LEVEL.WRITE,
  },
  {
    name: "a read share on one of the user's groups grants read",
    user: user({ id: OTHER_ID, groupIds: [GROUP_A] }),
    project: project({ shares: [share(GROUP_A, PROJECT_ACCESS.READ)] }),
    level: PROJECT_ACCESS_LEVEL.READ,
  },
  {
    name: "read + write shares on two of the user's groups take the stronger",
    user: user({ id: OTHER_ID, groupIds: [GROUP_A, GROUP_B] }),
    project: project({
      shares: [
        share(GROUP_A, PROJECT_ACCESS.READ),
        share(GROUP_B, PROJECT_ACCESS.WRITE),
      ],
    }),
    level: PROJECT_ACCESS_LEVEL.WRITE,
  },
  {
    name: "a share on a group the user is NOT in grants nothing",
    user: user({ id: OTHER_ID, groupIds: [GROUP_A] }),
    project: project({ shares: [share(GROUP_B, PROJECT_ACCESS.WRITE)] }),
    level: PROJECT_ACCESS_LEVEL.NONE,
  },
  {
    name: "a user in a group with no share on this project gets nothing",
    user: user({ id: OTHER_ID, groupIds: [GROUP_A] }),
    project: project(),
    level: PROJECT_ACCESS_LEVEL.NONE,
  },
  {
    name: "a public project is readable by any authenticated user",
    user: user({ id: OTHER_ID }),
    project: project({ isPublic: true }),
    level: PROJECT_ACCESS_LEVEL.READ,
  },
  {
    name: "public never upgrades an existing write share",
    user: user({ id: OTHER_ID, groupIds: [GROUP_A] }),
    project: project({
      isPublic: true,
      shares: [share(GROUP_A, PROJECT_ACCESS.WRITE)],
    }),
    level: PROJECT_ACCESS_LEVEL.WRITE,
  },
  {
    name: "a non-member on a non-public project gets none",
    user: user({ id: OTHER_ID }),
    project: project(),
    level: PROJECT_ACCESS_LEVEL.NONE,
  },
  {
    name: "a groupless user is unaffected by shares to other groups",
    user: user({ id: OTHER_ID, groupIds: [] }),
    project: project({ shares: [share(GROUP_A, PROJECT_ACCESS.READ)] }),
    level: PROJECT_ACCESS_LEVEL.NONE,
  },
]

for (const c of CASES) {
  test(`projectAccessLevel: ${c.name}`, () => {
    assert.equal(projectAccessLevel(c.user, c.project), c.level)
  })
}

// ---------------------------------------------------------------------------
// The derived predicates must never disagree with the level
// ---------------------------------------------------------------------------

test("canReadProject is exactly 'level is not none'", () => {
  for (const c of CASES) {
    assert.equal(
      canReadProject(c.user, c.project),
      c.level !== PROJECT_ACCESS_LEVEL.NONE,
      c.name,
    )
  }
})

test("canWriteProject is exactly 'level is owner or write'", () => {
  for (const c of CASES) {
    assert.equal(
      canWriteProject(c.user, c.project),
      c.level === PROJECT_ACCESS_LEVEL.OWNER ||
        c.level === PROJECT_ACCESS_LEVEL.WRITE,
      c.name,
    )
  }
})

test("isProjectOwner is exactly 'level is owner'", () => {
  for (const c of CASES) {
    assert.equal(
      isProjectOwner(c.user, c.project),
      c.level === PROJECT_ACCESS_LEVEL.OWNER,
      c.name,
    )
  }
})

test("a write-shared member may write but is not an owner", () => {
  const u = user({ id: OTHER_ID, groupIds: [GROUP_A] })
  const p = project({ shares: [share(GROUP_A, PROJECT_ACCESS.WRITE)] })

  assert.equal(canWriteProject(u, p), true, "may mutate the corpus")
  assert.equal(
    isProjectOwner(u, p),
    false,
    "may NOT delete or re-share — only the owner widens access",
  )
})

// ---------------------------------------------------------------------------
// The access column is a plain String; the guard is what keeps it honest
// ---------------------------------------------------------------------------

test("isProjectAccess accepts exactly the two stored values", () => {
  assert.equal(isProjectAccess("read"), true)
  assert.equal(isProjectAccess("write"), true)
  assert.equal(isProjectAccess("owner"), false)
  assert.equal(isProjectAccess(""), false)
  assert.equal(isProjectAccess("READ"), false)
})

test("an unrecognised access value in the DB grants nothing", () => {
  // Defence in depth: a row written by a future migration with an unknown
  // level must not be silently treated as a grant.
  const u = user({ id: OTHER_ID, groupIds: [GROUP_A] })
  const p = project({ shares: [share(GROUP_A, "admin")] })

  assert.equal(projectAccessLevel(u, p), PROJECT_ACCESS_LEVEL.NONE)
})
