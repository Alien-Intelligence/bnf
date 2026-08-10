// lib/testing/fixtures.ts
// Shared fixtures for the node:test suites. These hit the REAL dev Postgres
// (the same DB the app uses) — the "unit" layer here is deterministic (no LLM,
// no MCP, no HTTP) but not in-memory: BufferService/CorpusService are thin over
// Prisma, and mocking Prisma would test the mock, not the SQL. Every fixture is
// created under a stable name prefix so cleanupProjectsByPrefix can reclaim
// leftovers from a crashed run.
import "server-only"

import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { ProjectService } from "@/models/projects/service"
import { SESSION_SCOPE } from "@/models/sessions/schema"

/** Name prefix every throwaway test project carries, for prefix-sweep cleanup. */
export const TEST_PROJECT_PREFIX = "TEST buffer unit "

/** Create a throwaway user. `id` has no DB default (better-auth owns it). */
export async function createTestUser(): Promise<User> {
  const id = randomUUID()
  return prisma.user.create({
    data: {
      id,
      email: `test-${id}@bnf-unit.local`,
      name: "BnF unit test",
      emailVerified: true,
    },
  })
}

/** Create a throwaway project (with its seq=1 empty head version) for a user. */
export async function createTestProject(ownerId: string, label = ""): Promise<Project> {
  return ProjectService.create({
    name: `${TEST_PROJECT_PREFIX}${label} ${new Date().toISOString()}`,
    subtitle: "unit fixture",
    ownerId,
  })
}

/** Create an AppSession of the given scope for a project. */
export async function createTestSession(
  projectId: string,
  scope: (typeof SESSION_SCOPE)[keyof typeof SESSION_SCOPE],
): Promise<string> {
  const session = await prisma.appSession.create({
    data: { id: randomUUID(), projectId, scope, title: "unit session", status: "active" },
  })
  return session.id
}

/** Delete a throwaway user after its projects are cleaned up. */
export async function deleteTestUser(userId: string): Promise<void> {
  // Sessions/accounts cascade off User (onDelete: Cascade in the auth models);
  // projects must already be cleaned via cleanupProject before this runs.
  await prisma.user.deleteMany({ where: { id: userId } })
}
