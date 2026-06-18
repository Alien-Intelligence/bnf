import "server-only"
import { prisma } from "@/lib/db"
import type { NoteWithCitations, NoteListItem } from "./schema"

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
