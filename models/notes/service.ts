import "server-only"
import { prisma } from "@/lib/db"
import type { Note, Prisma } from "@/lib/generated/prisma/client"
import { parseCitations } from "@/lib/citations/syntax"

export class NoteService {
  static async create(args: {
    projectId: string
    appSessionId?: string | null
    title: string
    bodyMd: string
  }): Promise<Note> {
    const citations = parseCitations(args.bodyMd)
    return prisma.$transaction(async (tx) => {
      const note = await tx.note.create({
        data: {
          projectId: args.projectId,
          appSessionId: args.appSessionId ?? null,
          title: args.title,
          body_md: args.bodyMd,
          citationCount: citations.length,
          updatedAt: new Date(),
        },
      })
      if (citations.length) {
        await tx.citation.createMany({
          data: citations.map((c) => ({
            noteId: note.id,
            ark: c.ark,
            folio: c.folio,
            label: c.label,
          })),
        })
      }
      return note
    })
  }

  static async update(id: string, args: { title?: string; bodyMd?: string }): Promise<Note> {
    return prisma.$transaction(async (tx) => {
      const current = await tx.note.findUniqueOrThrow({ where: { id } })
      const nextBody = args.bodyMd ?? current.body_md
      const nextTitle = args.title ?? current.title
      return NoteService.snapshotAndReplace(tx, current, {
        title: nextTitle,
        body: nextBody,
        bodyChanged: args.bodyMd !== undefined,
      })
    })
  }

  /**
   * Append Markdown to the END of a note without rewriting the whole body —
   * the caller emits only the new text (far cheaper than `update` for adding
   * findings). The addition is separated from the prior body by a blank line so
   * Markdown blocks (headings, lists) render correctly. Prior body is
   * snapshotted; citations are re-parsed over the combined body. An empty
   * addition is a no-op (no version churn).
   */
  static async append(id: string, args: { bodyMd: string }): Promise<Note> {
    return prisma.$transaction(async (tx) => {
      const current = await tx.note.findUniqueOrThrow({ where: { id } })
      const addition = args.bodyMd.trim()
      if (addition.length === 0) return current

      const base = current.body_md.replace(/\s+$/, "")
      const nextBody = base.length ? `${base}\n\n${addition}` : addition
      return NoteService.snapshotAndReplace(tx, current, {
        title: current.title,
        body: nextBody,
        bodyChanged: true,
      })
    })
  }

  /**
   * Shared mutation core for `update` and `append`: snapshot the current body
   * to a new NoteVersion, then write the next title/body. When the body
   * changed, replace the Citation rows by re-parsing the full next body. Must
   * run inside a transaction (callers pass the tx client).
   */
  private static async snapshotAndReplace(
    tx: Prisma.TransactionClient,
    current: Note,
    next: { title: string; body: string; bodyChanged: boolean },
  ): Promise<Note> {
    const lastVersion = await tx.noteVersion.findFirst({
      where: { noteId: current.id },
      orderBy: { seq: "desc" },
      select: { seq: true },
    })
    const nextSeq = (lastVersion?.seq ?? -1) + 1
    await tx.noteVersion.create({
      data: { noteId: current.id, seq: nextSeq, body_md: current.body_md },
    })

    let citationCount = current.citationCount
    if (next.bodyChanged) {
      await tx.citation.deleteMany({ where: { noteId: current.id } })
      const cites = parseCitations(next.body)
      if (cites.length) {
        await tx.citation.createMany({
          data: cites.map((c) => ({
            noteId: current.id,
            ark: c.ark,
            folio: c.folio,
            label: c.label,
          })),
        })
      }
      citationCount = cites.length
    }

    return tx.note.update({
      where: { id: current.id },
      data: {
        title: next.title,
        body_md: next.body,
        citationCount,
        updatedAt: new Date(),
      },
    })
  }

  static async delete(id: string): Promise<void> {
    await prisma.note.delete({ where: { id } })
  }
}
