import "server-only"
import { prisma } from "@/lib/db"
import type { Note, NoteWithCitations, NoteListItem, NoteVersionListItem } from "./schema"

export class NoteQueries {
  static async listForProject(projectId: string): Promise<NoteListItem[]> {
    return prisma.note.findMany({
      where: { projectId },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
      select: {
        id: true,
        title: true,
        updatedAt: true,
        citationCount: true,
        pinned: true,
        createdAt: true,
      },
    })
  }

  static async get(id: string): Promise<NoteWithCitations | null> {
    return prisma.note.findUnique({
      where: { id },
      include: { citations: true },
    }) as Promise<NoteWithCitations | null>
  }

  /**
   * A note, but only if it belongs to `projectId`.
   *
   * `get` above is for the HTTP routes, which load the note and then put it
   * through `NotePolicy` — the policy is what scopes them. The agent tool layer
   * has no such step: it takes a note id straight out of the model's output,
   * and a note id names any note in the database. Scoping the read here is what
   * keeps one project's agent out of another project's carnet. A note that
   * exists but belongs elsewhere is indistinguishable from one that does not
   * exist, which is the correct answer to give a caller with no right to it.
   */
  static async getForProject(
    id: string,
    projectId: string,
  ): Promise<NoteWithCitations | null> {
    return prisma.note.findFirst({
      where: { id, projectId },
      include: { citations: true },
    }) as Promise<NoteWithCitations | null>
  }

  /**
   * Every note in the project with its full body, oldest first — the Carnet
   * reads the notebook front to back, so it needs the bodies `listForProject`
   * deliberately omits and the chronological order a rail listing does not use.
   */
  static async listForProjectWithBodies(projectId: string): Promise<Note[]> {
    return prisma.note.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    })
  }

  static async listVersions(noteId: string): Promise<NoteVersionListItem[]> {
    return prisma.noteVersion.findMany({
      where: { noteId },
      orderBy: { seq: "desc" },
      select: { id: true, seq: true, createdAt: true },
    })
  }

  static async citationsForArk(
    projectId: string,
    ark: string,
  ): Promise<{ noteId: string; folio: number | null; label: string | null; noteTitle: string }[]> {
    const rows = await prisma.citation.findMany({
      where: { ark, note: { projectId } },
      select: {
        noteId: true,
        folio: true,
        label: true,
        note: { select: { title: true } },
      },
    })
    return rows.map((r) => ({
      noteId: r.noteId,
      folio: r.folio,
      label: r.label,
      noteTitle: r.note.title,
    }))
  }
}
