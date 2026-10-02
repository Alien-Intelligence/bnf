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
 * page's (trimmed) text inside it — the `char_start` / `char_end` the worker
 * writes on the page's chunk. Mirror of worker-v2 `assembleMarkdown` +
 * `buildIndexChunks`.
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
    const body = p.text.trim()
    const start = offset + codePointLength(heading)
    const end = start + codePointLength(body)
    ranges.push([start, end])
    blocks.push(`${heading}${body}`)
    offset = end + codePointLength(FOLIO_BLOCK_SEPARATOR)
  }
  return { text: blocks.join(FOLIO_BLOCK_SEPARATOR), ranges }
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/**
 * A heading the worker could have written: at the very start of the text or
 * right after a block separator. `## Folio n` after a single newline is page
 * text (a Mistral-lane Markdown heading, say), never a boundary.
 *
 * Global on purpose; consume it through `matchAll` (which clones the regex),
 * never through a shared `.exec` loop that would leak `lastIndex`.
 */
export const ENTRY_FOLIO_HEADING_RE = /(?:^|(?<=\n\n))## Folio (\d+)\n\n/g

/**
 * Split processed entry text into folio → page text.
 *
 * Headings must be strictly increasing: a document's pages are stored in
 * `ordre` order, so a `## Folio n` whose n does not exceed the previous
 * heading's cannot be a boundary the worker wrote — it is page text and stays
 * inside the current folio.
 *
 * Text before the first heading — the title-and-metadata header that entries
 * from the pre-worker-v2 pipeline open with — belongs to no folio and is
 * dropped. Throws EntryFolioFormatError on text that carries no heading at
 * all: that is not an entry the worker wrote, and an empty map would let a
 * caller silently check quotes against nothing (CLAUDE_ERROR_PATTERNS §9).
 */
export function splitEntryFolios(text: string): DocumentFolios {
  const headings: Array<{ folio: number; start: number; bodyStart: number }> = []
  let previousFolio = -Infinity
  for (const m of text.matchAll(ENTRY_FOLIO_HEADING_RE)) {
    const folio = Number(m[1])
    if (folio <= previousFolio) continue
    headings.push({ folio, start: m.index, bodyStart: m.index + m[0].length })
    previousFolio = folio
  }

  const first = headings[0]
  if (first === undefined) {
    throw new EntryFolioFormatError(
      "no `## Folio <n>` heading found — this is not processed entry text written " +
        "by worker-v2 (see assembleMarkdown)",
    )
  }
  // Text before the first heading is a document header (entries written by the
  // pre-worker-v2 pipeline open with `# <title>` and a metadata block). It is
  // no page's text, so it belongs to no folio and is not returned.

  const folios = new Map<number, string>()
  for (const [i, h] of headings.entries()) {
    const next = headings[i + 1]
    let body = text.slice(h.bodyStart, next ? next.start : text.length)
    // Drop the separator the worker put before the next block. The page text
    // itself was trimmed on write, so a trailing blank line is never its own.
    if (next && body.endsWith(FOLIO_BLOCK_SEPARATOR)) {
      body = body.slice(0, -FOLIO_BLOCK_SEPARATOR.length)
    }
    folios.set(h.folio, body)
  }
  return folios
}
