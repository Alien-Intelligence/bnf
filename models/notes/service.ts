import "server-only"
import { prisma } from "@/lib/db"
import type { Note } from "@/lib/generated/prisma/client"
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

      // Snapshot prior body to NoteVersion before mutating.
      const lastVersion = await tx.noteVersion.findFirst({
        where: { noteId: id },
        orderBy: { seq: "desc" },
        select: { seq: true },
      })
      const nextSeq = (lastVersion?.seq ?? -1) + 1
      await tx.noteVersion.create({
        data: { noteId: id, seq: nextSeq, body_md: current.body_md },
      })

      // Replace citations if body changed.
      let citationCount = current.citationCount
      if (args.bodyMd !== undefined) {
        await tx.citation.deleteMany({ where: { noteId: id } })
        const cites = parseCitations(nextBody)
        if (cites.length) {
          await tx.citation.createMany({
            data: cites.map((c) => ({
              noteId: id,
              ark: c.ark,
              folio: c.folio,
              label: c.label,
            })),
          })
        }
        citationCount = cites.length
      }

      return tx.note.update({
        where: { id },
        data: {
          title: nextTitle,
          body_md: nextBody,
          citationCount,
          updatedAt: new Date(),
        },
      })
    })
  }

  static async delete(id: string): Promise<void> {
    await prisma.note.delete({ where: { id } })
  }
}
