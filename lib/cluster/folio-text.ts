// lib/cluster/folio-text.ts
// The app side of the folio-text contract with worker-v2.
//
// worker-v2 stores each ingested document's processed text as one Markdown
// string: every page is `## Folio <ordre>\n\n<trimmed text>`, and the pages are
// joined by `\n\n` (worker-v2/src/live/cluster.ts, assembleMarkdown). That
// heading is the ONLY folio boundary in the stored text, so anything that
// needs "the text of folio N" — the quote check, the fake cluster — writes and
// splits it through this module, exactly the way the worker does.
//
// OFFSETS ARE UNICODE CODE POINTS, not UTF-16 code units. The only consumer
// of a character offset into this text is mcp-datacluster's
// `datacluster_get_entry_content`, which slices a Python `str` (code points):
// MCPs/mcp-datacluster/src/tools/get_entry_content.py. A JS `String.length`
// would drift by one per astral-plane character (an emoji, a rare glyph in
// OCR or a vision description) before it.
//
// Both sides pin the same literal sample (CONTRACT tests in folio-text.test.ts
// and worker-v2/src/live/cluster.test.ts): markdown, offsets, and a non-BMP
// character and a whitespace-only page in it. Change the format on one side
// and that side's test goes red.
//
// Pure, no `server-only`: the fake RAG runner and the pure quote matcher both
// consume it, and the e2e harness runs it in a plain Node process.

/** `"## Folio <n>\n\n"` — the heading that opens each page block. */
export function folioHeading(folio: number): string {
  return `## Folio ${folio}\n\n`
}

/** The `"\n\n"` the worker puts between two folio blocks. */
export const FOLIO_BLOCK_SEPARATOR = "\n\n"

/** Folio number → the page text the worker stored for it, in document order. */
export type DocumentFolios = ReadonlyMap<number, string>

/** A page as the worker writes it: its folio (`ordre`) and its raw text. */
export type FolioPage = { folio: number; text: string }

/** The text is not processed entry text in the worker's format. */
export class EntryFolioFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EntryFolioFormatError"
  }
}

// ---------------------------------------------------------------------------
// Code points
// ---------------------------------------------------------------------------

/** Length in Unicode code points — the unit of every offset in this contract. */
export function codePointLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++, n++) {
    // A high surrogate followed by a low one is ONE code point (two units).
    // A lone surrogate counts as one, as it does in a Python `str`.
    const unit = s.charCodeAt(i)
    if (unit >= HIGH_SURROGATE_MIN && unit <= HIGH_SURROGATE_MAX && i + 1 < s.length) {
      const nextUnit = s.charCodeAt(i + 1)
      if (nextUnit >= LOW_SURROGATE_MIN && nextUnit <= LOW_SURROGATE_MAX) i++
    }
  }
  return n
}

const HIGH_SURROGATE_MIN = 0xd800
const HIGH_SURROGATE_MAX = 0xdbff
const LOW_SURROGATE_MIN = 0xdc00
const LOW_SURROGATE_MAX = 0xdfff

/** `s` sliced by code-point offsets, as Python's `s[start:end]` would. */
export function sliceCodePoints(s: string, start: number, end?: number): string {
  return Array.from(s).slice(start, end).join("")
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Assemble pages into processed entry text, and the code-point range of each
 * page's stored text (trimmed, heading-shaped lines escaped) inside it — the
 * `char_start` / `char_end` the worker writes on the page's chunk. Mirror of
 * worker-v2 `assembleMarkdown` + `buildIndexChunks`.
 */
export function assembleEntryText(pages: readonly FolioPage[]): {
  text: string
  ranges: Array<[number, number]>
} {
  const blocks: string[] = []
  const ranges: Array<[number, number]> = []
  let offset = 0
  for (const p of pages) {
    const heading = folioHeading(p.folio)
    const body = escapeFolioHeadings(p.text.trim())
    const start = offset + codePointLength(heading)
    const end = start + codePointLength(body)
    ranges.push([start, end])
    blocks.push(`${heading}${body}`)
    offset = end + codePointLength(FOLIO_BLOCK_SEPARATOR)
  }
  return { text: blocks.join(FOLIO_BLOCK_SEPARATOR), ranges }
}

// ---------------------------------------------------------------------------
// Escaping (mirror of worker-v2 escapeFolioHeadings)
// ---------------------------------------------------------------------------

/**
 * A line of page text that starts like a folio heading (`## Folio <digit>`,
 * after any backslashes) gets one more leading backslash, so it can never
 * read as a boundary the worker wrote.
 */
export function escapeFolioHeadings(text: string): string {
  return text.replace(/^(\\*)## Folio (\d)/gm, "\\$1## Folio $2")
}

/** The inverse of escapeFolioHeadings: one backslash off each escaped line. */
export function unescapeFolioHeadings(text: string): string {
  return text.replace(/^\\(\\*## Folio \d)/gm, "$1")
}

// ---------------------------------------------------------------------------
// Code-point → UTF-16 index (for slicing a long text many times)
// ---------------------------------------------------------------------------

/** `unitIndex[cp]` is the UTF-16 index of code point `cp` (and of the end). */
function codePointUnitIndex(text: string): Uint32Array {
  const index = new Uint32Array(codePointLength(text) + 1)
  let cp = 0
  for (let i = 0; i < text.length; i++, cp++) {
    index[cp] = i
    const unit = text.charCodeAt(i)
    if (unit >= HIGH_SURROGATE_MIN && unit <= HIGH_SURROGATE_MAX && i + 1 < text.length) {
      const nextUnit = text.charCodeAt(i + 1)
      if (nextUnit >= LOW_SURROGATE_MIN && nextUnit <= LOW_SURROGATE_MAX) i++
    }
  }
  index[cp] = text.length
  return index
}

// ---------------------------------------------------------------------------
// Boundaries from the chunks (the authority)
// ---------------------------------------------------------------------------

/** A page chunk as the worker indexed it: its folio and code-point range. */
export type FolioChunk = { folio: number; charStart: number; charEnd: number; text: string }

/**
 * The folio map of an entry, taken from its chunks — the worker writes one
 * chunk per page with the page's code-point range in the stored text, so the
 * boundaries are data, not parsed headings.
 *
 * The chunks must tile the text exactly as worker-v2 writes it: each range
 * preceded by its own `## Folio n\n\n` heading, consecutive pages joined by
 * the block separator, the first heading at offset 0, the last range ending
 * the text, each chunk's text equal to its slice, folios unique and
 * increasing. Returns null when they do not — chunks without offsets, or the
 * overlapping fixed windows of the pre-worker-v2 pipeline — so the caller
 * falls back to splitEntryFolios.
 */
export function foliosFromChunks(text: string, chunks: readonly FolioChunk[]): DocumentFolios | null {
  if (chunks.length === 0) return null
  const sorted = [...chunks].sort((a, b) => a.charStart - b.charStart)
  const sitsUnderItsHeading = pageChunkChecker(text)
  const unit = codePointUnitIndex(text)
  const cpLength = unit.length - 1
  const separatorLength = codePointLength(FOLIO_BLOCK_SEPARATOR)

  const folios = new Map<number, string>()
  let expectedHeadingStart = 0
  let previousFolio = 0
  for (const c of sorted) {
    const headingStart = c.charStart - codePointLength(folioHeading(c.folio))
    if (c.folio <= previousFolio || headingStart !== expectedHeadingStart || !sitsUnderItsHeading(c)) {
      return null
    }
    folios.set(c.folio, unescapeFolioHeadings(c.text))
    previousFolio = c.folio
    const separatorEnd = c.charEnd + separatorLength
    if (separatorEnd <= cpLength && text.slice(unit[c.charEnd], unit[separatorEnd]) !== FOLIO_BLOCK_SEPARATOR) {
      return null
    }
    expectedHeadingStart = separatorEnd
  }
  return sorted[sorted.length - 1].charEnd === cpLength ? folios : null
}

/**
 * A checker for single chunks against one entry text: does the chunk sit in
 * the text the way a worker-v2 page does (its own heading right before its
 * range, its text equal to its slice)? Lets a caller stop listing an older
 * entry's chunks — the pre-worker-v2 windows fail it at once — before paying
 * for every page. The code-point index is built once.
 */
export function pageChunkChecker(text: string): (chunk: FolioChunk) => boolean {
  const unit = codePointUnitIndex(text)
  const cpLength = unit.length - 1
  return (c) => {
    const headingStart = c.charStart - codePointLength(folioHeading(c.folio))
    return (
      headingStart >= 0 &&
      c.charStart <= c.charEnd &&
      c.charEnd <= cpLength &&
      text.slice(unit[headingStart], unit[c.charStart]) === folioHeading(c.folio) &&
      text.slice(unit[c.charStart], unit[c.charEnd]) === c.text
    )
  }
}

/** How many block-anchored `## Folio n` headings the text holds (an upper bound on its pages). */
export function countFolioHeadings(text: string): number {
  let n = 0
  for (const _match of text.matchAll(ENTRY_FOLIO_HEADING_RE)) n++
  return n
}

// ---------------------------------------------------------------------------
// Fallback: splitting on headings (entries without usable chunk offsets)
// ---------------------------------------------------------------------------

/**
 * The folio boundaries of an entry are ambiguous: the text alone cannot say
 * which `## Folio n` lines the worker wrote. The quote check reports that ARK
 * `unverifiable / folio_map_ambiguous` rather than guess.
 */
export class FolioMapAmbiguousError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FolioMapAmbiguousError"
  }
}

/**
 * A heading the worker could have written: at the very start of the text or
 * right after a block separator. Global on purpose; consume it through
 * `matchAll` (which clones the regex), never a shared `.exec` loop.
 */
export const ENTRY_FOLIO_HEADING_RE = /(?:^|(?<=\n\n))## Folio (\d+)\n\n/g

/**
 * The header the pre-worker-v2 pipeline put before the first folio: a
 * `# <title>` line, a blank line, then `**Key :** value` metadata lines
 * (author, date, type, ARK, pages), then a blank line.
 */
const LEGACY_HEADER_RE = /^# [^\n]*\S[^\n]*\n\n(?:\*\*[^*\n]+\*\*[^\n]*\n)+\n$/

/**
 * Split processed entry text into folio → page text on its headings — the
 * FALLBACK for entries whose chunks do not carry usable offsets (the
 * pre-worker-v2 pipeline). Strict: it never guesses.
 *
 * - Headings are block-anchored `## Folio n` lines (ENTRY_FOLIO_HEADING_RE)
 *   and must be strictly increasing; one that is not means page text holds a
 *   heading-shaped line, so the map is ambiguous (FolioMapAmbiguousError).
 *   (Entries written by worker-v2 escape such lines; old ones do not, and a
 *   page-text heading that happens to fit the sequence cannot be detected
 *   from the text — which is why chunk offsets are the authority.)
 * - Text before the first heading must be the documented legacy header
 *   (LEGACY_HEADER_RE); anything else is ambiguous too.
 * - Text with no heading at all is not an entry this app wrote
 *   (EntryFolioFormatError).
 * Page bodies are unescaped (unescapeFolioHeadings).
 */
export function splitEntryFolios(text: string): DocumentFolios {
  const headings: Array<{ folio: number; start: number; bodyStart: number }> = []
  for (const m of text.matchAll(ENTRY_FOLIO_HEADING_RE)) {
    headings.push({ folio: Number(m[1]), start: m.index, bodyStart: m.index + m[0].length })
  }
  const first = headings[0]
  if (first === undefined) {
    throw new EntryFolioFormatError(
      "no `## Folio <n>` heading found — this is not processed entry text written " +
        "by worker-v2 (see assembleMarkdown)",
    )
  }
  if (first.start > 0 && !LEGACY_HEADER_RE.test(text.slice(0, first.start))) {
    throw new FolioMapAmbiguousError(
      `${first.start} characters before the first \`## Folio <n>\` heading are not the documented ` +
        "`# <title>` + metadata header",
    )
  }
  for (const [i, h] of headings.entries()) {
    const previous = headings[i - 1]
    if (previous !== undefined && h.folio <= previous.folio) {
      throw new FolioMapAmbiguousError(
        `heading \`## Folio ${h.folio}\` follows \`## Folio ${previous.folio}\`: page text holds a ` +
          "heading-shaped line, and the text alone cannot say which",
      )
    }
  }

  const folios = new Map<number, string>()
  for (const [i, h] of headings.entries()) {
    const next = headings[i + 1]
    let body = text.slice(h.bodyStart, next ? next.start : text.length)
    // Drop the separator the worker put before the next block. The page text
    // itself was trimmed on write, so a trailing blank line is never its own.
    if (next && body.endsWith(FOLIO_BLOCK_SEPARATOR)) {
      body = body.slice(0, -FOLIO_BLOCK_SEPARATOR.length)
    }
    folios.set(h.folio, unescapeFolioHeadings(body))
  }
  return folios
}
