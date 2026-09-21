import "server-only"
import { prisma } from "@/lib/db"
import type { Note, Prisma } from "@/lib/generated/prisma/client"
import { parseCitations } from "@/lib/citations/syntax"
import { CorpusQueries } from "@/models/corpus/queries"

/**
 * A write, plus the ARKs it refused to record.
 *
 * Citation rows are a derived projection of the body, and only ARKs the corpus
 * actually holds get a row (playbook/citations.md). The body keeps the
 * offending text — the renderer shows it struck through — but the projection
 * must not, or a fabricated ARK would enter the citation index looking exactly
 * like a real one. `rejected` is what lets the tool handler tell the agent
 * which citation it invented, so it can correct itself within the turn.
 */
export type NoteWriteResult = { note: Note; rejected: string[] }

export class NoteService {
  /**
   * `corpusProjectId` is the project whose corpus the citations are validated
   * against — the SOURCE's when the note lives in a derived workspace, since
   * that is the corpus its citations are drawn from. Never re-derive it here;
   * callers resolve it once through `corpusProjectId()`.
   */
  static async create(args: {
    projectId: string
    corpusProjectId: string
    appSessionId?: string | null
    title: string
    bodyMd: string
  }): Promise<NoteWriteResult> {
    const known = await NoteService.knownArks(args.corpusProjectId)
    const { valid, rejected } = NoteService.splitCitations(args.bodyMd, known)

    const note = await prisma.$transaction(async (tx) => {
      const created = await tx.note.create({
        data: {
          projectId: args.projectId,
          appSessionId: args.appSessionId ?? null,
          title: args.title,
          body_md: args.bodyMd,
          citationCount: valid.length,
          updatedAt: new Date(),
        },
      })
      if (valid.length) {
        await tx.citation.createMany({
          data: valid.map((c) => ({
            noteId: created.id,
            ark: c.ark,
            folio: c.folio,
            label: c.label,
          })),
        })
      }
      return created
    })

    return { note, rejected }
  }

  /**
   * Returns `null` when no note with this id exists — deliberately, rather than
   * throwing. The agent tool layer calls this with an id the model produced,
   * which may name nothing at all; a `findUniqueOrThrow` there escapes the tool
   * loop as a 500 instead of giving the agent something it can recover from
   * (CLAUDE_ERROR_PATTERNS.md §15). The HTTP route turns the same `null` into a
   * 404.
   */
  static async update(
    id: string,
    corpusProjectId: string,
    args: { title?: string; bodyMd?: string },
  ): Promise<NoteWriteResult | null> {
    const known = await NoteService.knownArks(corpusProjectId)

    return prisma.$transaction(async (tx) => {
      const current = await tx.note.findUnique({ where: { id } })
      if (!current) return null
      const nextBody = args.bodyMd ?? current.body_md
      const nextTitle = args.title ?? current.title
      return NoteService.snapshotAndReplace(tx, current, known, {
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
   * addition is a no-op (no version churn). `null` when the note is gone — see
   * `update`.
   */
  static async append(
    id: string,
    corpusProjectId: string,
    args: { bodyMd: string },
  ): Promise<NoteWriteResult | null> {
    const known = await NoteService.knownArks(corpusProjectId)

    return prisma.$transaction(async (tx) => {
      const current = await tx.note.findUnique({ where: { id } })
      if (!current) return null
      const addition = args.bodyMd.trim()
      if (addition.length === 0) return { note: current, rejected: [] }

      const base = current.body_md.replace(/\s+$/, "")
      const nextBody = base.length ? `${base}\n\n${addition}` : addition
      return NoteService.snapshotAndReplace(tx, current, known, {
        title: current.title,
        body: nextBody,
        bodyChanged: true,
      })
    })
  }

  /** The ARKs a citation may legally point at. */
  private static async knownArks(corpusProjectId: string): Promise<Set<string>> {
    return new Set(await CorpusQueries.allArksInProject(corpusProjectId))
  }

  /**
   * Parsed citations split into the ones the corpus can vouch for and the ARKs
   * it cannot. Note links (`[[note:<id>|…]]`) are not citations and never reach
   * here — `parseCitations` yields only ARK references.
   */
  private static splitCitations(body: string, known: Set<string>) {
    const parsed = parseCitations(body)
    return {
      valid: parsed.filter((c) => known.has(c.ark)),
      rejected: [...new Set(parsed.filter((c) => !known.has(c.ark)).map((c) => c.ark))],
    }
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
    known: Set<string>,
    next: { title: string; body: string; bodyChanged: boolean },
  ): Promise<NoteWriteResult> {
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
    let rejected: string[] = []
    if (next.bodyChanged) {
      const split = NoteService.splitCitations(next.body, known)
      rejected = split.rejected
      await tx.citation.deleteMany({ where: { noteId: current.id } })
      if (split.valid.length) {
        await tx.citation.createMany({
          data: split.valid.map((c) => ({
            noteId: current.id,
            ark: c.ark,
            folio: c.folio,
            label: c.label,
          })),
        })
      }
      citationCount = split.valid.length
    }

    const note = await tx.note.update({
      where: { id: current.id },
      data: {
        title: next.title,
        body_md: next.body,
        citationCount,
        updatedAt: new Date(),
      },
    })

    return { note, rejected }
  }

  static async delete(id: string): Promise<void> {
    await prisma.note.delete({ where: { id } })
  }
}
