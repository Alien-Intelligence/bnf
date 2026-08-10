// lib/testing/project-cleanup.ts
// FK-safe teardown for test-created projects. There is NO clean `project.delete`
// path in this schema: only BufferItem carries `onDelete: Cascade` on its project
// relation (prisma/schema.prisma:622); Document, CorpusVersion, CorpusMembership,
// Note, AppSession, Message, ToolCall, etc. reference the project (directly or
// transitively) with a RESTRICT default. So a naive `prisma.project.delete` fails
// with a foreign-key violation. This helper deletes every project-scoped row in
// dependency order (children first), breaks the two self-/back-reference cycles
// (AppSession.activeMessageId → Message, Project.headVersionId → CorpusVersion),
// then removes the project itself.
//
// Test-only: never call this from app code. Used by node:test suites and the CI
// e2e wrapper to keep the dev database from accumulating throwaway projects.
import "server-only"

import { prisma } from "@/lib/db"

/**
 * Delete a single project and all rows that reference it, in FK-safe order.
 * Idempotent: a missing project (already cleaned) is a no-op, not an error.
 */
export async function cleanupProject(projectId: string): Promise<void> {
  const exists = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })
  if (!exists) return

  await prisma.$transaction([
    // 1. Break the AppSession → Message self-reference cycle before deleting
    //    messages (a session's activeMessageId points into its own messages).
    prisma.appSession.updateMany({ where: { projectId }, data: { activeMessageId: null } }),

    // 2. Message subtree (ToolCall is a child of Message).
    prisma.toolCall.deleteMany({ where: { message: { appSession: { projectId } } } }),
    prisma.message.deleteMany({ where: { appSession: { projectId } } }),

    // 3. Note subtree (Citation + NoteVersion are children of Note).
    prisma.citation.deleteMany({ where: { note: { projectId } } }),
    prisma.noteVersion.deleteMany({ where: { note: { projectId } } }),
    prisma.note.deleteMany({ where: { projectId } }),

    // 4. Corpus edge tables (reference CorpusVersion + Document + AppSession).
    prisma.corpusContribution.deleteMany({ where: { projectId } }),
    prisma.corpusMembership.deleteMany({ where: { projectId } }),

    // 5. Remaining direct project children.
    prisma.bufferItem.deleteMany({ where: { projectId } }),
    prisma.ingestJob.deleteMany({ where: { projectId } }),
    prisma.memoryItem.deleteMany({ where: { projectId } }),
    prisma.feedback.deleteMany({ where: { projectId } }),
    prisma.appSession.deleteMany({ where: { projectId } }),

    // 6. Break the Project → CorpusVersion pointer cycle, then delete documents
    //    and versions (CorpusMembership already gone, so both are now free).
    prisma.project.update({
      where: { id: projectId },
      data: { headVersionId: null, ingestedVersionId: null },
    }),
    prisma.document.deleteMany({ where: { projectId } }),
    prisma.corpusVersion.deleteMany({ where: { projectId } }),

    // 7. The project itself.
    prisma.project.delete({ where: { id: projectId } }),
  ])
}

/**
 * Delete every project whose name starts with `prefix` (and everything under
 * it). Used to sweep leftovers from crashed test runs — the e2e/unit suites name
 * their throwaway projects with a stable prefix so a later run can reclaim them.
 */
export async function cleanupProjectsByPrefix(prefix: string): Promise<number> {
  const projects = await prisma.project.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  })
  for (const p of projects) await cleanupProject(p.id)
  return projects.length
}
