// lib/cluster/folio-text.ts
// The app side of the folio-text contract with worker-v2.
//
// worker-v2 stores each ingested document's processed text as one Markdown
// string: every page is `## Folio <ordre>\n\n<text>`, and the pages are joined
// by `\n\n` (worker-v2/src/live/cluster.ts, assembleMarkdown). That heading is
// the ONLY folio boundary in the stored text, so anything that needs "the text
// of folio N" — the quote check, a reader of rag_get_text output — has to split
// on it, and has to split on it exactly the way the worker wrote it.
//
// Pure, no `server-only`: the fake RAG runner and the pure quote matcher both
// consume it, and the e2e harness runs it in a plain Node process.

/**
 * Mirror of worker-v2/src/live/cluster.ts assembleMarkdown:
 * `"## Folio <n>\n\n<text>"`, blocks joined by `"\n\n"`.
 *
 * Global + multiline on purpose; consume it through `matchAll` (which clones
 * the regex), never through a shared `.exec` loop that would leak `lastIndex`.
 */
export const ENTRY_FOLIO_HEADING_RE = /^## Folio (\d+)\n\n/gm

/** The `"\n\n"` the worker puts between two folio blocks. */
const FOLIO_BLOCK_SEPARATOR = "\n\n"

/** Folio number → the page text the worker stored for it, in document order. */
export type DocumentFolios = ReadonlyMap<number, string>

/**
 * Split processed entry text into folio → page text.
 *
 * Headings must be strictly increasing: a document's pages are stored in
 * `ordre` order, so a `## Folio n` line whose n does not exceed the previous
 * heading's cannot be a boundary the worker wrote — it is page text (an OCR'd
 * heading, say) and stays inside the current folio.
 *
 * Throws on text that carries no heading at all: that is not an entry this
 * app wrote, and returning an empty map would let a caller silently check
 * quotes against nothing (CLAUDE_ERROR_PATTERNS §9).
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

  if (headings.length === 0) {
    throw new Error(
      "splitEntryFolios: no `## Folio <n>` heading found — this is not processed " +
        "entry text written by worker-v2 (see assembleMarkdown)",
    )
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
    folios.set(h.folio, body)
  }
  return folios
}
