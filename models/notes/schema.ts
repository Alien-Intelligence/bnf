// models/notes/schema.ts
// Re-exported Prisma types + composite shapes for Note, NoteVersion, and Citation.
// No `import "server-only"` — schema is referenced by both client and server.
import type {
  Note,
  NoteVersion,
  Citation,
  DocumentFolio,
  DocumentOcr,
} from "@/lib/generated/prisma/client"

export type { Note, NoteVersion, Citation }

export type NoteWithCitations = Note & { citations: Citation[] }
export type NoteListItem = Pick<Note, "id" | "title" | "updatedAt" | "citationCount" | "pinned" | "createdAt">

/** Lightweight row returned by GET /api/notes/:nid/versions */
export type NoteVersionListItem = Pick<NoteVersion, "id" | "seq" | "createdAt">

/**
 * A note as every note view reads it (feedback 2026-09-29 #7): its citations,
 * the stored OCR quality of each cited folio, and the sync status of each
 * cited document — so a view can tell "low", "not low" and "not available yet"
 * apart. Built by NoteService.detail from the Citation rows only (the
 * corpus-validated ARKs) and read on the note's corpus (plan D8).
 *
 * `folioOcr` is the Prisma `DocumentFolio` row — every scalar column of the
 * table, the same shape as models/documents/schema.ts `DocumentFolioRow` —
 * typed from the client because schema.ts imports no other model.
 */
export type NoteDetail = NoteWithCitations & {
  folioOcr: DocumentFolio[]
  documentOcr: Array<Pick<DocumentOcr, "ark" | "status">>
}

/** DELETE /api/notes/:nid */
export type NoteDeleted = { deleted: true }

/** One note citing an ARK — GET /api/projects/:id/citations?ark= (NoteQueries.citationsForArk). */
export type CitationUsage = {
  noteId: string
  folio: number | null
  label: string | null
  noteTitle: string
}
