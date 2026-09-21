// models/agents/service.ts
// Business logic for agent sessions.
//
// As of the chat-sdk v0.4 migration, the turn lifecycle (start / persist /
// cancel / snapshot) is owned by the SDK's TurnRuntime + BnF's Prisma
// persistence adapter (lib/agent/persistence/prisma-adapter.ts). What remains
// here is the one piece of agent business logic that is NOT generic chat
// plumbing: building the per-session system prompt from memory + corpus.
import "server-only"

import type { AppLocale } from "@/i18n/routing"
import { prisma } from "@/lib/db"
import { ProjectQueries } from "@/models/projects/queries"
import type { ProjectWithShares } from "@/models/projects/schema"
import type { AppSession } from "./schema"

/**
 * AppSession with its parent Project pre-loaded — including the project's
 * shares, which lib/authz/project-access.ts reads. Route handlers pass
 * `{ session, project }` to AgentPolicy; policy methods never fetch, so the
 * project has to be loaded before `authorize()`.
 */
export type AppSessionWithProject = AppSession & {
  project: ProjectWithShares
}

export class AgentService {
  /**
   * Builds (or returns the cached) system prompt for the given session, in the
   * given working language.
   *
   * Delegates to `PromptBuilder.buildForSession`, which reads memory + corpus
   * snapshot and caches the result in `AppSession.systemPrompt` (tagged with
   * `promptLocale`). The cache is invalidated whenever `memory_write` is
   * called, and rebuilt when the requested locale differs from the cached one.
   *
   * Uses a dynamic import so this module does not take a hard static dependency
   * on the prompts module at evaluation time. The prompts module is always
   * present at runtime — we surface the error if it somehow isn't rather than
   * silently swallowing it.
   */
  static async buildSystemPrompt(
    session: AppSession,
    locale: AppLocale,
  ): Promise<string> {
    const { PromptBuilder } = await import("@/lib/agent/prompts/builder")
    return PromptBuilder.buildForSession(session, locale)
  }
}

/**
 * An AppSession plus the project an authorization check needs, composed from
 * the two canonical loaders rather than a second hand-rolled `include`.
 *
 * `ProjectQueries.get` is the only project loader an authorization path may use
 * (playbook/sharing.md) — it is what guarantees `shares` is present, and a
 * second loader is a second place to forget that the day the requirement
 * changes. Composing here rather than in `queries.ts` keeps that file free of
 * cross-model imports.
 */
export async function sessionWithProject(
  id: string,
): Promise<AppSessionWithProject | null> {
  const session = await prisma.appSession.findUnique({ where: { id } })
  if (!session) return null

  const project = await ProjectQueries.get(session.projectId)
  // The FK makes this unreachable; treating it as "no session" keeps the
  // caller's single not-found branch honest rather than throwing past it.
  if (!project) return null

  return { ...session, project }
}

/**
 * Like `sessionWithProject`, but for the per-turn callbacks, where the route
 * has already loaded and authorized the session — absence there is a bug, not
 * a 404.
 */
export async function sessionWithProjectOrThrow(
  id: string,
): Promise<AppSessionWithProject> {
  const found = await sessionWithProject(id)
  if (!found) throw new Error(`AppSession ${id} not found`)
  return found
}
