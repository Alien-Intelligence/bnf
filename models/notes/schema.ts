// models/notes/schema.ts
// Re-exported Prisma types + composite shapes for Note, NoteVersion, and Citation.
// No `import "server-only"` — schema is referenced by both client and server.
import type { Note, NoteVersion, Citation } from "@/lib/generated/prisma/client"
// Type-only, and the one sideways import of this schema: a NoteDetail carries
// the documents model's OCR row shapes, defined once there (models.md "define
// once" outranks "schema.ts imports no other model" for a composed response
// shape — recorded as a deviation in the Track B implementation log).
import type { NoteOcrRows } from "@/models/documents/schema"

export type { Note, NoteVersion, Citation }

export type NoteWithCitations = Note & { citations: Citation[] }
export type NoteListItem = Pick<Note, "id" | "title" | "updatedAt" | "citationCount" | "pinned" | "createdAt">

/** Lightweight row returned by GET /api/notes/:nid/versions */
export type NoteVersionListItem = Pick<NoteVersion, "id" | "seq" | "createdAt">

/** GET /api/notes/:nid/versions — the envelope of the note's version rows. */
export type NoteVersionList = { versions: NoteVersionListItem[] }

/**
 * A note as every note view reads it (feedback 2026-09-29 #7): its citations
 * and `ocr` — the stored OCR quality of each cited folio plus the sync status
 * of each cited document, so a view can tell "low", "not low", "not yet" and
 * "never" apart; or why they are not given: the derived workspace's corpus
 * grant was revoked (its own notes stay readable, the source's OCR rows are
 * no longer read), or the read failed (the note is still served). Built by
 * NoteService.detail(s) from the Citation rows only (the corpus-validated
 * ARKs) and read on the note's corpus (plan D8).
 */
export type NoteDetail = NoteWithCitations & { ocr: NoteOcrRows }

/** DELETE /api/notes/:nid */
export type NoteDeleted = { deleted: true }

/** One note citing an ARK — GET /api/projects/:id/citations?ark= (NoteQueries.citationsForArk). */
export type CitationUsage = {
  noteId: string
  folio: number | null
  label: string | null
  noteTitle: string
}
