/**
 * lib/citations/syntax.ts
 *
 * Pure citation parser/renderer — no server-only imports; safe to use both
 * client-side and server-side.
 *
 * Citation syntax:  [[<ark>|<label>|<folio>]]   (inline text citation → pill)
 * Image syntax:     ![[<ark>|<label>|<folio>]]  (embed the folio image → figure)
 * Note-link syntax: [[note:<id>|<label>]]       (inline link to another note → pill)
 *
 * The image form is the markdown-image flavour of a citation: same fields, a
 * leading `!`. The label is the figure caption. Both resolve to the same
 * (ark, folio) and the IIIF image URL is DERIVED at render time (see
 * lib/citations/external.iiifImageUrl) — never stored — exactly like the
 * citation source panel.
 *
 * The note-link form is the INTERNAL cross-reference: the research agent (and
 * the librarian) links one note to another so a complex project's notes
 * interconnect. It carries the target note's UUID and a free-text label; the
 * renderer turns it into a clickable pill that opens the target note. Unlike a
 * citation it is NOT projected to a DB table (render-only) and the `note:`
 * prefix keeps it fully disjoint from the `ark:/…` citation forms.
 *
 * Rules (from playbook/citations.md):
 *   - <ark>   must match `ark:/\d+/[A-Za-z0-9]+`
 *   - <label> is free text; `|` and `]]` are escaped with `\` on write and
 *             unescaped on read.  The regex captures the escaped form.
 *   - <folio> is a positive integer (IIIF vue index). An optional leading `f`
 *             (Gallica's vue label, e.g. `f1`) is tolerated on read and
 *             stripped — the agent often writes `f1` instead of `1`. We always
 *             write the canonical bare integer (see renderCitation).
 *
 * CITATION_REGEX / IMAGE_CITATION_REGEX are the single definition of valid
 * citation syntax. All code that inspects note bodies must use
 * parseCitations() / parseImageCitations() or these regexes — never a
 * hand-rolled scan.
 */

// The `(?<!!)` lookbehind makes a text citation NOT match the `[[…]]` inside an
// image embed `![[…]]` — the two constructs stay disjoint.
export const CITATION_REGEX =
  /(?<!!)\[\[(ark:\/\d+\/[A-Za-z0-9]+)\|((?:[^|\]]|\\\||\\\])+)\|f?(\d+)\]\]/g

/** Image embed: a citation prefixed with `!`, mirroring markdown image syntax. */
export const IMAGE_CITATION_REGEX =
  /!\[\[(ark:\/\d+\/[A-Za-z0-9]+)\|((?:[^|\]]|\\\||\\\])+)\|f?(\d+)\]\]/g

// A note-to-note link: `[[note:<uuid>|<label>]]`. The `note:` prefix and the
// canonical UUID shape make it disjoint from CITATION_REGEX (which requires
// `ark:/…`). The `(?<!!)` lookbehind keeps a stray `![[note:…]]` from matching,
// mirroring CITATION_REGEX. <label> escapes `|` and `]]` exactly like a citation.
export const NOTELINK_REGEX =
  /(?<!!)\[\[note:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\|((?:[^|\]]|\\\||\\\])+)\]\]/g

export type ParsedCitation = {
  /** The full ARK identifier, e.g. `ark:/12148/bpt6k2839841`. */
  ark: string
  /** Human-readable source label (pipes/brackets already unescaped). */
  label: string
  /** IIIF vue index (page number, integer ≥ 1). */
  folio: number
  /** Raw matched string as it appears in the note body. */
  raw: string
  /** Character offset of this match in the source string. */
  index: number
  /** Byte-length of the raw match (convenience for slicing). */
  length: number
}

export type ParsedNoteLink = {
  /** The target note's UUID. */
  noteId: string
  /** Human-readable link label (pipes/brackets already unescaped). */
  label: string
  /** Raw matched string as it appears in the note body. */
  raw: string
  /** Character offset of this match in the source string. */
  index: number
  /** Byte-length of the raw match (convenience for slicing). */
  length: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function escapeCitationText(s: string): string {
  return s.replaceAll("|", "\\|").replaceAll("]]", "\\]]")
}

export function unescapeCitationText(s: string): string {
  return s.replaceAll("\\|", "|").replaceAll("\\]]", "]]")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function parseWith(md: string, regex: RegExp): ParsedCitation[] {
  const out: ParsedCitation[] = []
  for (const m of md.matchAll(regex)) {
    out.push({
      ark: m[1],
      label: unescapeCitationText(m[2]),
      folio: Number(m[3]),
      raw: m[0],
      index: m.index ?? 0,
      length: m[0].length,
    })
  }
  return out
}

/**
 * Extract all inline text citations (`[[…]]`, excluding image embeds) from a
 * Markdown body. Returns them in source order; label is already unescaped.
 */
export function parseCitations(md: string): ParsedCitation[] {
  return parseWith(md, CITATION_REGEX)
}

/**
 * Extract all image embeds (`![[…]]`) from a Markdown body, in source order.
 * Same shape as a citation; `raw` includes the leading `!`.
 */
export function parseImageCitations(md: string): ParsedCitation[] {
  return parseWith(md, IMAGE_CITATION_REGEX)
}

/**
 * Extract all note-to-note links (`[[note:<id>|<label>]]`) from a Markdown
 * body, in source order; label is already unescaped.
 */
export function parseNoteLinks(md: string): ParsedNoteLink[] {
  const out: ParsedNoteLink[] = []
  for (const m of md.matchAll(NOTELINK_REGEX)) {
    out.push({
      noteId: m[1],
      label: unescapeCitationText(m[2]),
      raw: m[0],
      index: m.index ?? 0,
      length: m[0].length,
    })
  }
  return out
}

/**
 * Serialize a citation back to the `[[ark|label|folio]]` wire format.
 * Escapes pipes and closing brackets in the label.
 */
export function renderCitation(c: { ark: string; label: string; folio: number }): string {
  return `[[${c.ark}|${escapeCitationText(c.label)}|${c.folio}]]`
}

/**
 * Serialize a note link back to the `[[note:<id>|<label>]]` wire format.
 * Escapes pipes and closing brackets in the label.
 */
export function renderNoteLink(l: { noteId: string; label: string }): string {
  return `[[note:${l.noteId}|${escapeCitationText(l.label)}]]`
}
