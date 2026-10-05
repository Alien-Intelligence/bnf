// lib/authz/workspace-header.test.ts
// The project half of the workspace header, decided on the server from the
// same predicates the routes enforce. `steps` must agree with the pages'
// guards and `mayShare` with ProjectPolicy.share — a header offering a step
// that 404s, or a Share button the route refuses, is the drift this module
// exists to prevent. Fixtures follow lib/agent/tools/derived-scope.test.ts.

import { test } from "node:test"
import assert from "node:assert/strict"
import { Prisma } from "@/lib/generated/prisma/client"

import {
  mayOpenAdminConsole,
  workspaceHeaderProject,
  workspaceHeaderViewer,
} from "./workspace-header"
import { PROJECT_ACCESS } from "./project-access"
import { RESEARCH_ONLY_STEPS, WORKSPACE_STEPS } from "@/lib/constants"
import { USER_ROLE, type PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"

const GROUP = "group-a"

function user(over: Partial<PolicyUser> & Pick<PolicyUser, "id">): PolicyUser {
  return {
    email: `${over.id}@example.test`,
    emailVerified: true,
    name: over.id,
    image: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    role: USER_ROLE.MEMBER,
    alienUserId: null,
    groupIds: [],
    ...over,
  }
}

function project(over: Partial<ProjectWithShares> = {}): ProjectWithShares {
  return {
    id: "project-1",
    ownerId: "owner",
    name: "Presse 1937",
    subtitle: null,
    isPublic: false,
    headVersionId: null,
    ingestedVersionId: null,
    clusterDatasetId: null,
    paidOcrEnabled: true,
    paidOcrBudgetUsd: null,
    // The column's real type and default (prisma/schema.prisma: Decimal @default(0)).
    paidOcrSpentUsd: new Prisma.Decimal(0),
    corpusSourceId: null,
    corpusSourceShareId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    shares: [],
    ...over,
  }
}

const owner = user({ id: "owner" })
const member = user({ id: "member", groupIds: [GROUP] })
const admin = user({ id: "admin", role: USER_ROLE.ADMIN })

test("the owner of an own project: may share, full progression", () => {
  const h = workspaceHeaderProject(owner, project())
  assert.deepEqual(h, {
    id: "project-1",
    name: "Presse 1937",
    steps: WORKSPACE_STEPS,
    mayShare: true,
  })
})

test("a write-share member: full steps, but no share button", () => {
  const h = workspaceHeaderProject(
    member,
    project({ shares: [{ id: "s1", groupId: GROUP, access: PROJECT_ACCESS.WRITE }] }),
  )
  assert.equal(h?.mayShare, false)
  assert.deepEqual(h?.steps, WORKSPACE_STEPS)
})

test("a read-share member: research only, no share button", () => {
  const h = workspaceHeaderProject(
    member,
    project({ shares: [{ id: "s1", groupId: GROUP, access: PROJECT_ACCESS.READ }] }),
  )
  assert.equal(h?.mayShare, false)
  assert.deepEqual(h?.steps, RESEARCH_ONLY_STEPS)
})

test("the owner of a derived workspace: research only, and may NOT re-share the corpus", () => {
  const h = workspaceHeaderProject(
    member,
    project({ ownerId: member.id, corpusSourceId: "source-1", corpusSourceShareId: "s1" }),
  )
  assert.equal(h?.mayShare, false)
  assert.deepEqual(h?.steps, RESEARCH_ONLY_STEPS)
})

test("an admin on a foreign own-corpus project resolves to owner: may share", () => {
  assert.equal(workspaceHeaderProject(admin, project())?.mayShare, true)
})

test("an admin on a derived project still may not share it", () => {
  const h = workspaceHeaderProject(
    admin,
    project({ corpusSourceId: "source-1", corpusSourceShareId: "s1" }),
  )
  assert.equal(h?.mayShare, false)
})

test("an account granted nothing gets no project header at all: no name, no steps, no share", () => {
  const stranger = user({ id: "stranger", groupIds: ["group-b"] })
  assert.equal(
    workspaceHeaderProject(
      stranger,
      project({ shares: [{ id: "s1", groupId: GROUP, access: PROJECT_ACCESS.READ }] }),
    ),
    null,
  )
})

test("the viewer: the admin console link follows the console's own rule", () => {
  assert.deepEqual(workspaceHeaderViewer(admin), {
    name: admin.name,
    email: admin.email,
    isAdmin: true,
  })
  assert.equal(workspaceHeaderViewer(member).isAdmin, false)
  assert.equal(mayOpenAdminConsole({ role: USER_ROLE.GUEST }), false)
})
