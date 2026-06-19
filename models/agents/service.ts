// models/agents/service.ts
// Business logic for agent sessions.
//
// As of the chat-sdk v0.4 migration, the turn lifecycle (start / persist /
// cancel / snapshot) is owned by the SDK's TurnRuntime + BnF's Prisma
// persistence adapter (lib/agent/persistence/prisma-adapter.ts). What remains
// here is the one piece of agent business logic that is NOT generic chat
// plumbing: building the per-session system prompt from memory + corpus.
import "server-only"

import type { AppSession } from "./schema"

export class AgentService {
  /**
   * Builds (or returns the cached) system prompt for the given session.
   *
   * Delegates to `PromptBuilder.buildForSession`, which reads memory + corpus
   * snapshot and caches the result in `AppSession.systemPrompt`. The cache is
   * invalidated whenever `memory_write` is called.
   *
   * Uses a dynamic import so this module does not take a hard static dependency
   * on the prompts module at evaluation time. The prompts module is always
   * present at runtime — we surface the error if it somehow isn't rather than
   * silently swallowing it.
   */
  static async buildSystemPrompt(session: AppSession): Promise<string> {
    const { PromptBuilder } = await import("@/lib/agent/prompts/builder")
    return PromptBuilder.buildForSession(session)
  }
}
