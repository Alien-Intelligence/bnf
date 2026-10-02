// models/notes/schema.ts
// Re-exported Prisma types + composite shapes for Note, NoteVersion, and Citation.
// No `import "server-only"` — schema is referenced by both client and server.
import type {
  Note,
  NoteVersion,
  Citation,
  DocumentFolio,
} from "@/lib/generated/prisma/client"

export type { Note, NoteVersion, Citation }

export type NoteWithCitations = Note & { citations: Citation[] }
export type NoteListItem = Pick<Note, "id" | "title" | "updatedAt" | "citationCount" | "pinned" | "createdAt">

/** Lightweight row returned by GET /api/notes/:nid/versions */
export type NoteVersionListItem = Pick<NoteVersion, "id" | "seq" | "createdAt">

/**
 * The stored OCR quality of one folio a note cites (feedback 2026-09-29 #7).
 * Typed from the Prisma client rather than imported from the documents model
 * (playbook/models.md: no sideways model imports); it is the same shape as
 * models/documents/schema.ts DocumentFolioRow, which renderers turn into a
 * FolioOcrView.
 */
export type NoteFolioOcr = Pick<
  DocumentFolio,
  "ark" | "folio" | "ocrSource" | "ocrQuality" | "wordCount"
>

/**
 * A note as every note view reads it: its citations plus the stored OCR
 * quality of each cited (ark, folio). Loaded only through those Citation rows,
 * which hold the corpus-validated ARKs alone — so the per-ARK quality table is
 * never read for an ARK outside the note's corpus (plan D8).
 */
export type NoteDetail = NoteWithCitations & { folioOcr: NoteFolioOcr[] }

/** One note citing an ARK — GET /api/projects/:id/citations?ark= (NoteQueries.citationsForArk). */
export type CitationUsage = {
  noteId: string
  folio: number | null
  label: string | null
  noteTitle: string
}

/**
 * The cited (ark, folio) pairs of some Citation rows, grouped by ARK with
 * deduped folios in first-seen order. A row without a folio cites no page and
 * is skipped. The input of the folio-quality lookup in NoteQueries.
 */
export function citationRefs(
  citations: Array<Pick<Citation, "ark" | "folio">>,
): Array<{ ark: string; folios: number[] }> {
  const byArk = new Map<string, number[]>()
  for (const c of citations) {
    if (c.folio === null) continue
    const folios = byArk.get(c.ark) ?? []
    if (!folios.includes(c.folio)) folios.push(c.folio)
    byArk.set(c.ark, folios)
  }
  return [...byArk].map(([ark, folios]) => ({ ark, folios }))
}
