import "server-only"
import { prisma } from "@/lib/db"
import {
  noteWithCitations,
  type CitationUsage,
  type NoteBodyRow,
  type NoteWithCitations,
  type NoteListItem,
  type NoteVersionListItem,
  type NoteOrderBy,
} from "./schema"

/**
 * The note-list order — pinned first, then most recently updated — of every
 * read that lists notes (the note list, note_list): written once.
 */
const NOTE_LIST_ORDER: NoteOrderBy[] = [
  { pinned: "desc" },
  { updatedAt: "desc" },
]

export class NoteQueries {
  /** Every note of a project with its body, oldest first (the quote audit). */
  static async listBodiesForProject(projectId: string): Promise<NoteBodyRow[]> {
    return prisma.note.findMany({
      where: { projectId },
      select: { id: true, title: true, body_md: true },
      orderBy: { createdAt: "asc" },
    })
  }

  /** The bodies of these notes (the e2e harness); a missing id is simply absent from the result. */
  static async bodiesByIds(ids: string[]): Promise<Array<Pick<NoteBodyRow, "id" | "body_md">>> {
    return prisma.note.findMany({ where: { id: { in: ids } }, select: { id: true, body_md: true } })
  }

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
      ...noteWithCitations,
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
      ...noteWithCitations,
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
      ...noteWithCitations,
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
