import "server-only"
import { prisma } from "@/lib/db"
import type { AppSession } from "@/lib/generated/prisma/client"
import {
  AUTO_TITLE_PLACEHOLDERS,
  DEFAULT_SESSION_TITLE,
  FIRST_SESSION_TITLE,
} from "@/lib/constants"
import { generateSessionTitle } from "@/lib/agent/title"

export class SessionService {
  /**
   * Returns the first session for the given project + scope, creating one if
   * none exists. Safe to call from a Server Component render path.
   */
  static async ensureDefaultForScope(
    projectId: string,
    scope: "corpus" | "research",
  ): Promise<AppSession> {
    const existing = await prisma.appSession.findFirst({
      where: { projectId, scope },
      orderBy: { createdAt: "asc" },
    })

    if (existing) return existing

    return prisma.appSession.create({
      data: {
        projectId,
        scope,
        title: FIRST_SESSION_TITLE,
        status: "active",
        updatedAt: new Date(),
      },
    })
  }

  /**
   * Create a session. With no `title` it's born with the placeholder
   * DEFAULT_SESSION_TITLE — the first message will auto-name it via
   * {@link maybeAutoTitle}. The librarian can still rename it any time.
   */
  static async create(
    projectId: string,
    scope: string,
    title?: string,
  ): Promise<AppSession> {
    return prisma.appSession.create({
      data: {
        projectId,
        scope,
        title: title ?? DEFAULT_SESSION_TITLE,
        status: "active",
        updatedAt: new Date(),
      },
    })
  }

  /**
   * Name a session from its first user message — but only if it's still wearing
   * a placeholder title. A session the user (or a prior auto-title) already
   * named is left untouched. Best-effort: the caller treats a thrown error as
   * non-fatal, since the placeholder remains a perfectly usable title.
   */
  static async maybeAutoTitle(
    sessionId: string,
    firstMessage: string,
  ): Promise<void> {
    const session = await prisma.appSession.findUnique({
      where: { id: sessionId },
      select: { title: true },
    })
    if (!session || !AUTO_TITLE_PLACEHOLDERS.includes(session.title)) return

    const title = await generateSessionTitle(firstMessage)
    if (!title) return

    // Re-check under the placeholder guard: only overwrite if the title hasn't
    // been changed (e.g. a manual rename) while the model was generating.
    await prisma.appSession.updateMany({
      where: { id: sessionId, title: { in: [...AUTO_TITLE_PLACEHOLDERS] } },
      data: { title },
    })
  }

  static async rename(id: string, title: string): Promise<AppSession> {
    return prisma.appSession.update({
      where: { id },
      data: { title },
    })
  }

  static async archive(id: string): Promise<void> {
    await prisma.appSession.update({
      where: { id },
      data: { status: "archived" },
    })
  }
}
