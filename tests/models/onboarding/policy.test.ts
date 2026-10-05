// tests/models/onboarding/policy.test.ts
// The intro-seen flags are self-scoped: a user marks only their own.
import "server-only"

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import type { User } from "@/lib/generated/prisma/client"
import { createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { OnboardingPolicy } from "@/models/onboarding/policy"

let row: User

before(async () => {
  row = await createTestUser()
})

after(async () => {
  await deleteTestUser(row.id)
})

test("a user may mark their own intro as seen, and nobody else's", () => {
  const policy = new OnboardingPolicy({ ...row, groupIds: [] })
  assert.equal(policy.markSeen(row.id), true)
  assert.equal(policy.markSeen("someone-else"), false)
})
