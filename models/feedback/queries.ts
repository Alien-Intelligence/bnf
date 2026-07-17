import "server-only"
import { prisma } from "@/lib/db"
import { FEEDBACK_TARGET, type AdminFeedbackRow, type Feedback } from "./schema"

/** Trim a rated turn's answer text to a compact one-line excerpt. */
function excerpt(text: string | null): string {
  if (!text) return ""
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat
}

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

  /**
   * Every feedback row across every project, enriched for the admin console:
   * project name, author, and the target resolved to a human label (note title,
   * session title, or turn excerpt) plus the session scope needed to build the
   * deep-link. Team-wide, NOT user-scoped — the admin gate lives at the route.
   *
   * Targets are resolved in three batched reads (one per target kind), so the
   * cost is O(1) queries regardless of how many feedback rows exist. A target
   * that was deleted since resolves to `null`.
   */
  static async listAllResolvedForAdmin(): Promise<AdminFeedbackRow[]> {
    const rows = await prisma.feedback.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        project: { select: { name: true } },
        user: { select: { name: true, email: true } },
      },
    })

    const noteIds: string[] = []
    const sessionIds: string[] = []
    const messageIds: string[] = []
    for (const r of rows) {
      if (r.target === FEEDBACK_TARGET.NOTE) noteIds.push(r.targetId)
      else if (r.target === FEEDBACK_TARGET.SESSION) sessionIds.push(r.targetId)
      else if (r.target === FEEDBACK_TARGET.TURN) messageIds.push(r.targetId)
    }

    const [notes, sessions, messages] = await Promise.all([
      noteIds.length
        ? prisma.note.findMany({
            where: { id: { in: noteIds } },
            select: { id: true, title: true },
          })
        : [],
      sessionIds.length
        ? prisma.appSession.findMany({
            where: { id: { in: sessionIds } },
            select: { id: true, title: true, scope: true },
          })
        : [],
      messageIds.length
        ? prisma.message.findMany({
            where: { id: { in: messageIds } },
            select: {
              id: true,
              content: true,
              appSession: { select: { scope: true } },
            },
          })
        : [],
    ])

    const noteById = new Map(notes.map((n) => [n.id, n]))
    const sessionById = new Map(sessions.map((s) => [s.id, s]))
    const messageById = new Map(messages.map((m) => [m.id, m]))

    return rows.map((r) => {
      let resolved: AdminFeedbackRow["resolved"] = null

      if (r.target === FEEDBACK_TARGET.NOTE) {
        const note = noteById.get(r.targetId)
        if (note) resolved = { label: note.title, sessionScope: null }
      } else if (r.target === FEEDBACK_TARGET.SESSION) {
        const session = sessionById.get(r.targetId)
        if (session) {
          resolved = { label: session.title, sessionScope: session.scope }
        }
      } else if (r.target === FEEDBACK_TARGET.TURN) {
        const message = messageById.get(r.targetId)
        if (message) {
          resolved = {
            label: excerpt(message.content),
            sessionScope: message.appSession.scope,
          }
        }
      }

      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        rating: r.rating,
        comment: r.comment,
        target: r.target,
        targetId: r.targetId,
        projectId: r.projectId,
        projectName: r.project.name,
        userName: r.user.name,
        userEmail: r.user.email,
        resolved,
      }
    })
  }
}
