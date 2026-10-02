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

// The parts of a citation, defined ONCE and composed into every regex below.
//
// The folio is the one definition of a valid folio, shared by everything that
// scans with these regexes (the parser, note-body.tsx, the exporter): a
// positive integer — an optional `f` and leading zeros tolerated, never 0 — of
// at most 15 significant digits, so `Number()` of it is always a safe integer.
const ARK_PART = String.raw`(ark:\/\d+\/[A-Za-z0-9]+)`
const LABEL_PART = String.raw`((?:[^|\]]|\\\||\\\])+)`
const FOLIO_PART = String.raw`f?(0*[1-9]\d{0,14})`
const STRICT_BODY = String.raw`\[\[${ARK_PART}\|${LABEL_PART}\|${FOLIO_PART}\]\]`

// The `(?<!!)` lookbehind makes a text citation NOT match the `[[…]]` inside an
// image embed `![[…]]` — the two constructs stay disjoint.
export const CITATION_REGEX = new RegExp(String.raw`(?<!!)${STRICT_BODY}`, "g")

/** Image embed: a citation prefixed with `!`, mirroring markdown image syntax. */
export const IMAGE_CITATION_REGEX = new RegExp(String.raw`!${STRICT_BODY}`, "g")

/** A whole string that is exactly one valid citation or image embed. */
const STRICT_CITATION_EXACT = new RegExp(String.raw`^!?${STRICT_BODY}$`)

/**
 * Anything shaped like a citation of an ARK — `[[ark:…` up to `]]`, with or
 * without the `!` — whatever follows the ARK: only for finding the ones the
 * strict syntax rejects (no folio, a non-integer or zero folio, a range…).
 */
const CITATION_SHAPE_REGEX = new RegExp(String.raw`!?\[\[${ARK_PART}((?:\\\]|[^\]])*)\]\]`, "g")

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
      index: m.index,
      length: m[0].length,
    })
  }
  return out
}

/** A citation-shaped `[[ark|…]]` whose folio is missing or not a valid page. */
export type InvalidFolioCitation = {
  ark: string
  /** What stood where the folio belongs, as written ("" when there was none). */
  folio: string
  raw: string
}

/**
 * Citations (or image embeds) of an ARK that the strict syntax rejects for
 * their folio — missing (`[[ark|Le Figaro]]`), not an integer (`|abc`, `|1-2`,
 * `|1.5`, `|p. 3`), negative, `0`, or too long to be a page. They render as
 * plain text and are not projected, so the agent must be told
 * (`invalid_citation`, playbook/citations.md) instead of the text silently not
 * being a citation.
 */
export function findInvalidFolioCitations(md: string): InvalidFolioCitation[] {
  const out: InvalidFolioCitation[] = []
  for (const m of md.matchAll(CITATION_SHAPE_REGEX)) {
    if (STRICT_CITATION_EXACT.test(m[0])) continue
    // The folio is what follows the last unescaped `|`; with a single field
    // (only a label, or nothing), there is no folio at all.
    const fields = m[2].split(/(?<!\\)\|/)
    const folio = fields.length >= 3 ? (fields.at(-1) ?? "") : ""
    out.push({ ark: m[1], folio, raw: m[0] })
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
      index: m.index,
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
