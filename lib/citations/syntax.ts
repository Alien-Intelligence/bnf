/**
 * lib/citations/syntax.ts
 *
 * Pure citation parser/renderer — no server-only imports; safe to use both
 * client-side and server-side.
 *
 * Citation syntax:  [[<ark>|<label>|<folio>]]
 *
 * Rules (from playbook/citations.md):
 *   - <ark>   must match `ark:/\d+/[A-Za-z0-9]+`
 *   - <label> is free text; `|` and `]]` are escaped with `\` on write and
 *             unescaped on read.  The regex captures the escaped form.
 *   - <folio> is a positive integer (IIIF vue index).
 *
 * CITATION_REGEX is the single definition of valid citation syntax.
 * All code that inspects note bodies must use parseCitations() or this regex —
 * never a hand-rolled scan.
 */

export const CITATION_REGEX =
  /\[\[(ark:\/\d+\/[A-Za-z0-9]+)\|((?:[^|\]]|\\\||\\\])+)\|(\d+)\]\]/g

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function escapeCitationText(s: string): string {
  return s.replaceAll("|", "\\|").replaceAll("]]", "\\]]")
}

function unescapeCitationText(s: string): string {
  return s.replaceAll("\\|", "|").replaceAll("\\]]", "]]")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract all citations from a Markdown body.
 * Returns them in source order; label is already unescaped.
 */
export function parseCitations(md: string): ParsedCitation[] {
  const out: ParsedCitation[] = []
  for (const m of md.matchAll(CITATION_REGEX)) {
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
 * Serialize a citation back to the `[[ark|label|folio]]` wire format.
 * Escapes pipes and closing brackets in the label.
 */
export function renderCitation(c: { ark: string; label: string; folio: number }): string {
  return `[[${c.ark}|${escapeCitationText(c.label)}|${c.folio}]]`
}

// ---------------------------------------------------------------------------
// Tokenizer — split body into text and citation segments
// ---------------------------------------------------------------------------

export type CitationSegment =
  | { type: "text"; text: string }
  | { type: "citation"; citation: ParsedCitation }

/**
 * Split a Markdown body into alternating text and citation segments.
 * Useful for renderers that need to intersperse BadgeArkCitation pills.
 */
export function tokenizeMarkdown(md: string): CitationSegment[] {
  const segments: CitationSegment[] = []
  let lastIndex = 0

  for (const m of md.matchAll(CITATION_REGEX)) {
    const idx = m.index ?? 0
    if (idx > lastIndex) {
      segments.push({ type: "text", text: md.slice(lastIndex, idx) })
    }
    segments.push({
      type: "citation",
      citation: {
        ark: m[1],
        label: unescapeCitationText(m[2]),
        folio: Number(m[3]),
        raw: m[0],
        index: idx,
        length: m[0].length,
      },
    })
    lastIndex = idx + m[0].length
  }

  if (lastIndex < md.length) {
    segments.push({ type: "text", text: md.slice(lastIndex) })
  }

  return segments
}
