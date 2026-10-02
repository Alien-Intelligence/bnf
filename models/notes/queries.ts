import "server-only"
import { prisma } from "@/lib/db"
import {
  citationRefs,
  type CitationUsage,
  type NoteDetail,
  type NoteFolioOcr,
  type NoteWithCitations,
  type NoteListItem,
  type NoteVersionListItem,
} from "./schema"

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
   * A note with its citations AND the stored OCR quality of every cited folio
   * — what every note view renders (pill markers, the low-OCR banner, the
   * exports). Null when no note has this id. Two Prisma calls in the owning
   * model (playbook/models.md, "a join across models").
   */
  static async getDetail(id: string): Promise<NoteDetail | null> {
    const note = await prisma.note.findUnique({ where: { id }, include: { citations: true } })
    if (!note) return null
    return { ...note, folioOcr: await NoteQueries.folioOcrFor(note.citations) }
  }

  /**
   * Every note of the project as a NoteDetail, oldest first — the standalone
   * Carnet. One folio-quality query covers all the notes' citations.
   */
  static async listDetailsForProject(projectId: string): Promise<NoteDetail[]> {
    const notes = await prisma.note.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      include: { citations: true },
    })
    const rows = await NoteQueries.folioOcrFor(notes.flatMap((n) => n.citations))
    return notes.map((note) => {
      const refs = citationRefs(note.citations)
      return {
        ...note,
        folioOcr: rows.filter((r) =>
          refs.some((ref) => ref.ark === r.ark && ref.folios.includes(r.folio)),
        ),
      }
    })
  }

  /**
   * The stored quality of the cited (ark, folio) pairs — read ONLY through
   * Citation rows, which hold corpus-validated ARKs (plan D8). PK-scoped.
   */
  private static async folioOcrFor(
    citations: Array<{ ark: string; folio: number | null }>,
  ): Promise<NoteFolioOcr[]> {
    const refs = citationRefs(citations)
    if (refs.length === 0) return []
    return prisma.documentFolio.findMany({
      where: { OR: refs.map(({ ark, folios }) => ({ ark, folio: { in: folios } })) },
      select: { ark: true, folio: true, ocrSource: true, ocrQuality: true, wordCount: true },
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
    }) as Promise<NoteWithCitations | null>
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
