import "server-only"
import { prisma } from "@/lib/db"
import type { AppSession } from "@/lib/generated/prisma/client"

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
        title: "Première session",
        status: "active",
        updatedAt: new Date(),
      },
    })
  }

  static async create(
    projectId: string,
    scope: string,
    title: string,
  ): Promise<AppSession> {
    return prisma.appSession.create({
      data: {
        projectId,
        scope,
        title,
        status: "active",
        updatedAt: new Date(),
      },
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
