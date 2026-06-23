// lib/notes/export.ts
// Export a note (or the whole carnet) as PORTABLE Markdown — the kind a normal
// viewer renders. Our internal note body uses BnF-specific syntax that no other
// renderer understands:
//   [[ark|label|folio]]   inline text citation
//   ![[ark|caption|folio]] folio image embed
// Both are rewritten here into standard Markdown links/images, with the IIIF /
// Gallica URLs derived from (ark, folio) — exactly as the reader derives them.
//
// Shared by the Atelier (single active note), the in-espace Carnet, and the
// standalone Carnet page so all three export the same way.

import {
  CITATION_REGEX,
  IMAGE_CITATION_REGEX,
  unescapeCitationText,
} from "@/lib/citations/syntax"
import { gallicaItemUrl, iiifImageUrl } from "@/lib/citations/external"

type ExportableNote = { title: string; body_md: string | null }

/** Escape the characters that would break Markdown link/image text. */
function escapeLinkText(label: string): string {
  return label.replace(/[[\]]/g, "\\$&")
}

/**
 * Rewrite our internal citation/image syntax into standard Markdown:
 *   ![[ark|caption|folio]] → [![caption](IIIF image)](Gallica page)
 *   [[ark|label|folio]]    → [label](Gallica page)
 * Images are replaced first; CITATION_REGEX's negative lookbehind keeps it from
 * matching the `[[…]]` inside an image embed, so the order isn't load-bearing.
 */
export function toPortableMarkdown(body: string): string {
  return body
    .replace(IMAGE_CITATION_REGEX, (_m, ark: string, label: string, folio: string) => {
      const f = Number(folio)
      const caption = escapeLinkText(unescapeCitationText(label))
      return `[![${caption}](${iiifImageUrl(ark, f)})](${gallicaItemUrl(ark, f)})`
    })
    .replace(CITATION_REGEX, (_m, ark: string, label: string, folio: string) => {
      const caption = escapeLinkText(unescapeCitationText(label))
      return `[${caption}](${gallicaItemUrl(ark, Number(folio))})`
    })
}

/** One note as a standalone Markdown document (`# Title` + portable body). */
export function noteToMarkdown(note: ExportableNote): string {
  return `# ${note.title}\n\n${toPortableMarkdown(note.body_md ?? "")}\n`
}

/** Several notes stitched into one document, `---` between entries. */
export function notesToMarkdown(notes: ExportableNote[]): string {
  return notes
    .map((n) => `## ${n.title}\n\n${toPortableMarkdown(n.body_md ?? "")}\n`)
    .join("\n---\n\n")
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
