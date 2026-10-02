import "server-only"
import { prisma } from "@/lib/db"
import type { Prisma } from "@/lib/generated/prisma/client"
import {
  type CitationUsage,
  type NoteWithCitations,
  type NoteListItem,
  type NoteVersionListItem,
} from "./schema"

/**
 * The note-list order — pinned first, then most recently updated — of every
 * read that lists notes (the note list, note_list): written once.
 */
const NOTE_LIST_ORDER: Prisma.NoteOrderByWithRelationInput[] = [
  { pinned: "desc" },
  { updatedAt: "desc" },
]

export class NoteQueries {
  static async listForProject(projectId: string): Promise<NoteListItem[]> {
    return prisma.note.findMany({
      where: { projectId },
      orderBy: NOTE_LIST_ORDER,
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
    })
  }

  /**
   * Every note of the project with its citations, in the note-list order (the
   * order of listForProject) — note_list's one read. NoteService.details adds
   * the cited folios' OCR quality.
   */
  static async listWithCitationsForProject(projectId: string): Promise<NoteWithCitations[]> {
    return prisma.note.findMany({
      where: { projectId },
      orderBy: NOTE_LIST_ORDER,
      include: { citations: true },
    })
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
    })
  }

  static async listVersions(noteId: string): Promise<NoteVersionListItem[]> {
    return prisma.noteVersion.findMany({
      where: { noteId },
      orderBy: { seq: "desc" },
      select: { id: true, seq: true, createdAt: true },
    })
  }

  static async citationsForArk(projectId: string, ark: string): Promise<CitationUsage[]> {
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
