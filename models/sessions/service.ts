import "server-only"
import {
  AUTO_TITLE_PLACEHOLDERS,
  DEFAULT_SESSION_TITLE,
  FIRST_SESSION_TITLE,
} from "@/lib/constants"
import { generateSessionTitle } from "@/lib/agent/title"
import { SessionQueries } from "./queries"
import type { AppSession, SessionScope } from "./schema"

export class SessionService {
  /**
   * Returns the first session for the given project + scope, creating one if
   * none exists. Safe to call from a Server Component render path.
   */
  static async ensureDefaultForScope(projectId: string, scope: SessionScope): Promise<AppSession> {
    const existing = await SessionQueries.firstForScope(projectId, scope)
    if (existing) return existing
    return SessionQueries.create(projectId, scope, FIRST_SESSION_TITLE)
  }

  /**
   * Create a session. With no `title` it's born with the placeholder
   * DEFAULT_SESSION_TITLE — the first message will auto-name it via
   * {@link maybeAutoTitle}. The librarian can still rename it any time.
   */
  static async create(projectId: string, scope: SessionScope, title?: string): Promise<AppSession> {
    return SessionQueries.create(projectId, scope, title ?? DEFAULT_SESSION_TITLE)
  }

  /**
   * Name a session from its first user message — but only if it's still wearing
   * a placeholder title. A session the user (or a prior auto-title) already
   * named is left untouched. Best-effort: the caller treats a thrown error as
   * non-fatal, since the placeholder remains a perfectly usable title.
   */
  static async maybeAutoTitle(sessionId: string, firstMessage: string): Promise<void> {
    const current = await SessionQueries.titleOf(sessionId)
    if (current === null || !AUTO_TITLE_PLACEHOLDERS.includes(current)) return

    const title = await generateSessionTitle(firstMessage)
    if (!title) return

    // Re-check under the placeholder guard: only overwrite if the title hasn't
    // been changed (e.g. a manual rename) while the model was generating.
    await SessionQueries.setTitleIfPlaceholder(sessionId, title, AUTO_TITLE_PLACEHOLDERS)
  }

  static async rename(id: string, title: string): Promise<AppSession> {
    return SessionQueries.rename(id, title)
  }

  static async archive(id: string): Promise<void> {
    await SessionQueries.archive(id)
  }
}
