import "server-only"
import { prisma } from "@/lib/db"
import type { Feedback } from "./schema"

export class FeedbackQueries {
  /**
   * The existing feedback a user left on a given target, if any. Used by the
   * service upsert path and, later, to prefill the dialog when a user reopens
   * it. Reads only — the unique index (userId, target, targetId) guarantees at
   * most one row.
   */
  static async findForTarget(
    userId: string,
    target: string,
    targetId: string,
  ): Promise<Feedback | null> {
    return prisma.feedback.findUnique({
      where: { userId_target_targetId: { userId, target, targetId } },
    })
  }

  /**
   * Every feedback row the user has left across this project — the source for
   * the per-target "already rated / edit" state in the UI. Scoped to the
   * authenticated user (not a team-wide viewer): one cached query backs every
   * feedback button on the page.
   */
  static async listForUserInProject(
    userId: string,
    projectId: string,
  ): Promise<Feedback[]> {
    return prisma.feedback.findMany({
      where: { userId, projectId },
      orderBy: { updatedAt: "desc" },
    })
  }
}
