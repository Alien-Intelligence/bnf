// lib/notes/export.ts
// Export a note (or the whole carnet) as PORTABLE Markdown — the kind a normal
// viewer renders. Our internal note body uses BnF-specific syntax that no other
// renderer understands:
//   [[ark|label|folio]]   inline text citation
//   ![[ark|caption|folio]] folio image embed
//   [[note:<id>|label]]   internal note-to-note cross-reference (no external URL)
// Both are rewritten here into standard Markdown links/images, with the IIIF /
// Gallica URLs derived from (ark, folio) — exactly as the reader derives them.
//
// Shared by the Atelier (single active note), the in-espace Carnet, and the
// standalone Carnet page so all three export the same way.
//
// Low-OCR disclaimer (feedback 2026-09-29 #7, plan D13): a note citing at least
// one low-OCR folio exports BnF's disclaimer as a blockquote right under its
// title, and each low text citation gets a marker after its Gallica link. The
// strings come from i18n (the UI's current locale) through `ExportCopy`. A note
// with no low citation exports byte-identically to before (export.test.ts).

import {
  CITATION_REGEX,
  IMAGE_CITATION_REGEX,
  NOTELINK_REGEX,
  unescapeCitationText,
} from "@/lib/citations/syntax"
import { gallicaItemUrl, iiifImageUrl } from "@/lib/citations/external"
import { citationOcrSummary } from "@/lib/citations/ocr"
import { buildOcrIndex, folioOcrState, type OcrIndex } from "@/lib/ocr/quality"
import type { DocumentFolioRow, DocumentOcrStatusRow } from "@/models/documents/schema"

/**
 * A note as the exports need it: its body, the stored quality of its cited
 * folios and the sync status of the documents it cites (NoteDetail).
 */
type ExportableNote = {
  title: string
  body_md: string | null
  folioOcr: DocumentFolioRow[]
  documentOcr: DocumentOcrStatusRow[]
}

/** The translated low-OCR strings, in the UI's current locale (`citations.ocr`). */
export type ExportCopy = {
  /** BnF's disclaimer, verbatim (`citations.ocr.disclaimer`). */
  disclaimer: string
  /** Appended after a low citation's link (`citations.ocr.exportLowMarker`). */
  lowMarker: string
}

/** Escape the characters that would break Markdown link/image text. */
function escapeLinkText(label: string): string {
  return label.replace(/[[\]]/g, "\\$&")
}

/**
 * Rewrite our internal citation/image syntax into standard Markdown:
 *   ![[ark|caption|folio]] → [![caption](IIIF image)](Gallica page)
 *   [[ark|label|folio]]    → [label](Gallica page)
 *   [[note:<id>|label]]    → **label**   (internal ref; no portable URL)
 * Images are replaced first; CITATION_REGEX's negative lookbehind keeps it from
 * matching the `[[…]]` inside an image embed, so the order isn't load-bearing.
 * The note-link replace runs last and is independent (its `note:` prefix never
 * matches the citation/image regexes).
 */
function toPortableMarkdown(
  body: string,
  index: OcrIndex,
  copy: ExportCopy,
): string {
  return body
    .replace(IMAGE_CITATION_REGEX, (_m, ark: string, label: string, folio: string) => {
      const f = Number(folio)
      const caption = escapeLinkText(unescapeCitationText(label))
      return `[![${caption}](${iiifImageUrl(ark, f)})](${gallicaItemUrl(ark, f)})`
    })
    .replace(CITATION_REGEX, (_m, ark: string, label: string, folio: string) => {
      const f = Number(folio)
      const caption = escapeLinkText(unescapeCitationText(label))
      const link = `[${caption}](${gallicaItemUrl(ark, f)})`
      // Only a MEASURED low folio is marked; a folio whose quality is not
      // available is not claimed either way (plan D3).
      const state = folioOcrState(index, ark, f)
      return state.kind === "recorded" && state.view.low ? `${link} ${copy.lowMarker}` : link
    })
    .replace(NOTELINK_REGEX, (_m, _id: string, label: string) => {
      return `**${escapeLinkText(unescapeCitationText(label))}**`
    })
}

/**
 * A note's title line (`heading`), then the disclaimer blockquote when it cites
 * a low folio, then its portable body.
 */
function noteSection(note: ExportableNote, heading: string, copy: ExportCopy): string {
  const body = note.body_md ?? ""
  const index = buildOcrIndex(note.folioOcr, note.documentOcr)
  const disclaimer =
    citationOcrSummary(body, index).low.length > 0 ? `> ${copy.disclaimer}\n\n` : ""
  return `${heading} ${note.title}\n\n${disclaimer}${toPortableMarkdown(body, index, copy)}\n`
}

/** One note as a standalone Markdown document (`# Title` + portable body). */
export function noteToMarkdown(note: ExportableNote, copy: ExportCopy): string {
  return noteSection(note, "#", copy)
}

/** Several notes stitched into one document, `---` between entries. */
export function notesToMarkdown(notes: ExportableNote[], copy: ExportCopy): string {
  return notes.map((n) => noteSection(n, "##", copy)).join("\n---\n\n")
}

/** kebab-case a title into a safe filename stem; `fallback` when it folds away. */
export function filenameFromTitle(title: string, fallback: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return `${slug || fallback}.md`
}

/** Trigger a browser download of `content` as `filename`. Client-only. */
export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
