import "server-only"
import { prisma } from "@/lib/db"
import type { Project, User, Feedback } from "@/lib/generated/prisma/client"
import { FEEDBACK_TARGET } from "./schema"
import type { SubmitFeedbackInput } from "./types"

/**
 * Thrown when the feedback target does not exist or does not belong to the
 * project being authorized. Both cases surface as a 404 to the caller — we do
 * not distinguish "absent" from "belongs to another project" (no existence
 * leak). The route maps this to notFound().
 */
export class FeedbackTargetNotFoundError extends Error {
  constructor(message = "Feedback target introuvable") {
    super(message)
    this.name = "FeedbackTargetNotFoundError"
  }
}

export class FeedbackService {
  /**
   * Record a librarian's rating on a session, note, or turn. The DB is the
   * source of truth; no Langfuse call happens here. One row per (user, target,
   * targetId) — re-submitting revises the existing row in place (upsert on the
   * unique index).
   *
   * Steps:
   *  1. Resolve the target and verify it belongs to `project` (the integrity
   *     guard the DB cannot express across a polymorphic target). The same load
   *     yields the session id for the deferred Langfuse join.
   *  2. Derive `langfuseSessionId` (= the owning AppSession.id, when one exists).
   *  3. Upsert the row and return it.
   */
  static async submit(args: {
    project: Project
    user: User
    input: SubmitFeedbackInput
  }): Promise<Feedback> {
    const { project, user, input } = args
    const langfuseSessionId = await FeedbackService.resolveTarget(project, input)

    return prisma.feedback.upsert({
      where: {
        userId_target_targetId: {
          userId: user.id,
          target: input.target,
          targetId: input.targetId,
        },
      },
      create: {
        projectId: project.id,
        userId: user.id,
        target: input.target,
        targetId: input.targetId,
        langfuseSessionId,
        rating: input.rating,
        comment: input.comment ?? null,
      },
      update: {
        rating: input.rating,
        comment: input.comment ?? null,
        langfuseSessionId,
      },
    })
  }

  /**
   * Verify the target exists within `project` and return the AppSession.id to
   * record as `langfuseSessionId` (null only when a note has no owning session).
   * Throws {@link FeedbackTargetNotFoundError} on any mismatch.
   */
  private static async resolveTarget(
    project: Project,
    input: SubmitFeedbackInput,
  ): Promise<string | null> {
    switch (input.target) {
      case FEEDBACK_TARGET.SESSION: {
        const session = await prisma.appSession.findUnique({
          where: { id: input.targetId },
          select: { id: true, projectId: true },
        })
        if (!session || session.projectId !== project.id) {
          throw new FeedbackTargetNotFoundError()
        }
        return session.id
      }
      case FEEDBACK_TARGET.NOTE: {
        const note = await prisma.note.findUnique({
          where: { id: input.targetId },
          select: { projectId: true, appSessionId: true },
        })
        if (!note || note.projectId !== project.id) {
          throw new FeedbackTargetNotFoundError()
        }
        return note.appSessionId
      }
      case FEEDBACK_TARGET.TURN: {
        const message = await prisma.message.findUnique({
          where: { id: input.targetId },
          select: { appSessionId: true, appSession: { select: { projectId: true } } },
        })
        if (!message || message.appSession.projectId !== project.id) {
          throw new FeedbackTargetNotFoundError()
        }
        return message.appSessionId
      }
    }
  }
}
