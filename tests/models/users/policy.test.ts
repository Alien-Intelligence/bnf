// tests/models/users/policy.test.ts
// UserPolicy.signOut: POST /api/sign-out acts on the session withAuth
// resolved, and only its owner may end it — an admin included.

import { test } from "node:test"
import assert from "node:assert/strict"

import { UserPolicy } from "@/models/users/policy"
import { USER_ROLE, type PolicyUser } from "@/models/users/schema"

function user(id: string, role: PolicyUser["role"]): PolicyUser {
  return {
    id,
    email: `${id}@example.test`,
    emailVerified: true,
    name: id,
    image: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    role,
    alienUserId: null,
    groupIds: [],
  }
}

const member = user("member", USER_ROLE.MEMBER)
const admin = user("admin", USER_ROLE.ADMIN)

test("a user may end their own session", () => {
  assert.equal(new UserPolicy(member).signOut({ id: "s1", userId: member.id }), true)
})

test("a user may not end someone else's session", () => {
  assert.equal(new UserPolicy(member).signOut({ id: "s2", userId: "other" }), false)
})

test("an admin may not end someone else's session either: that is not sign-out", () => {
  assert.equal(new UserPolicy(admin).signOut({ id: "s3", userId: member.id }), false)
})
