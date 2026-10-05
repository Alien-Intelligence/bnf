/**
 * lib/citations/quotes.ts
 *
 * Pure quote extractor — no server-only imports; safe on both sides, like
 * syntax.ts. Finds the quotation spans of a Markdown note body, attributes
 * each one to a `[[ark|label|folio]]` citation, and splits its text into the
 * segments (around `[…]`) and tokens the matcher (quote-match.ts) aligns
 * against the folio text.
 *
 * Quote forms (plan D8): French guillemets « … » (nesting-aware: an inner
 * « » pair is content), curly “ … ” (an EN session quoting a French original;
 * a curly pair inside « » is content), and `>` blockquotes. ASCII "…" is not a
 * quote form: it is ambiguous with code, labels and tool syntax.
 *
 * Attribution, in order:
 *   1. the first citation after the closing mark, in the same Markdown block,
 *      with no other quote opening in between;
 *   2. otherwise the nearest citation before the quote in the same block, with
 *      no other quote in between;
 *   3. otherwise a citation written inside the quote marks (it is removed from
 *      the quoted text either way);
 *   4. otherwise null — an uncited quote.
 * A block is a paragraph, a list item, or a blockquote plus the attribution
 * line right after it.
 *
 * Bounded work: scanNoteQuotes takes the caller's OutOfTime (deadline.ts) and
 * ticks it inside every loop over the body (lines, characters of a block,
 * spans), so a dense 200 KB paragraph cannot run past the check's budget.
 * Attribution is indexed per block (spans and citations sorted once, binary
 * search per quote), O(n log n) in the quotes of a block.
 *
 * Normalisation is shared with the matcher through `normalizeToken`: NFC,
 * French lower-case, typographic apostrophes → `'`, Markdown emphasis markers
 * dropped, leading/trailing punctuation stripped per whitespace token. Inner
 * characters stay, so an OCR `ma:son` remains one token and is compared as is.
 */

import { QUOTE_UNBALANCED_MARKS_MAX_PER_BLOCK } from "@/lib/constants"
import { QuoteMatchDeadlineError, StopCheck, type OutOfTime, type StopReason } from "./deadline"
import { QUOTE_FORM, type QuoteCitation, type QuoteForm } from "@/models/notes/schema"
import { CITATION_REGEX, IMAGE_CITATION_REGEX, NOTELINK_REGEX, parseCitations } from "./syntax"

export type QuoteToken =
  /** `bracketed` = written as `[mot]`, the correction mark of bracketed mode. */
  | { kind: "word"; norm: string; bracketed: boolean }
  /** `[illisible]` — stands for 1..QUOTE_ILLEGIBLE_MAX_WORDS source words. */
  | { kind: "illegible" }

export type QuoteSegment = { tokens: QuoteToken[] }

export type ExtractedQuote = {
  /** The quoted text as written (marks excluded, blockquote prefixes removed, trimmed). */
  raw: string
  form: QuoteForm
  /** Offset of the opening mark (or of the blockquote) in the body. */
  index: number
  citation: QuoteCitation | null
  /** The text split on elision markers; a segment always has ≥ 1 token. */
  segments: QuoteSegment[]
  /** Number of elision markers, standard or not. */
  elisions: number
  /** Markers written `(…)` / `(...)` rather than `[…]` / `[...]`. */
  nonstandardMarkers: number
  /** Word + illegible tokens over all segments (QUOTE_MIN_CHECKED_WORDS applies to it). */
  words: number
}

// ---------------------------------------------------------------------------
// Normalisation (shared with quote-match.ts)
// ---------------------------------------------------------------------------

const APOSTROPHES = /[’ʼ‘]/g
const EMPHASIS_STAR = /\*/g
const EDGE_UNDERSCORE = /^_+|_+$/g
const LEADING_PUNCT = /^[^\p{L}\p{N}]+/u
const TRAILING_PUNCT = /[^\p{L}\p{N}]+$/u

/** One whitespace-delimited token → its comparable form ("" when nothing is left). */
export function normalizeToken(raw: string): string {
  return raw
    .normalize("NFC")
    .toLocaleLowerCase("fr")
    .replace(APOSTROPHES, "'")
    .replace(EMPHASIS_STAR, "")
    .replace(EDGE_UNDERSCORE, "")
    .replace(LEADING_PUNCT, "")
    .replace(TRAILING_PUNCT, "")
}

// ---------------------------------------------------------------------------
// Tokens and segments
// ---------------------------------------------------------------------------

/** `[mot]`, possibly wrapped in punctuation or emphasis: `**[maison]**,` */
const BRACKETED_TOKEN = /^[^\p{L}\p{N}[]*\[([^[\]]+)\][^\p{L}\p{N}\]]*$/u
const ILLEGIBLE_WORD = "illisible"

/** `[…]` / `[...]` (standard) and `(…)` / `(...)` (non-standard, still an elision). */
const ELISION_MARKER = /\[\s*(?:…|\.{3})\s*\]|\(\s*(?:…|\.{3})\s*\)/g

function tokenize(text: string): QuoteToken[] {
  const out: QuoteToken[] = []
  for (const raw of text.split(/\s+/)) {
    if (raw.length === 0) continue
    const bracketed = BRACKETED_TOKEN.exec(raw)
    if (bracketed) {
      const inner = normalizeToken(bracketed[1])
      if (inner === ILLEGIBLE_WORD) out.push({ kind: "illegible" })
      else if (inner.length > 0) out.push({ kind: "word", norm: inner, bracketed: true })
      continue
    }
    const norm = normalizeToken(raw)
    if (norm.length > 0) out.push({ kind: "word", norm, bracketed: false })
  }
  return out
}

/** Quote text with citations, image embeds and note links removed. */
function stripReferences(text: string): string {
  return text.replace(IMAGE_CITATION_REGEX, " ").replace(CITATION_REGEX, " ").replace(NOTELINK_REGEX, " ")
}

function segment(text: string): Pick<ExtractedQuote, "segments" | "elisions" | "nonstandardMarkers" | "words"> {
  let elisions = 0
  let nonstandardMarkers = 0
  const pieces: string[] = []
  let last = 0
  for (const m of text.matchAll(ELISION_MARKER)) {
    elisions++
    if (m[0].startsWith("(")) nonstandardMarkers++
    pieces.push(text.slice(last, m.index))
    last = m.index + m[0].length
  }
  pieces.push(text.slice(last))

  const segments: QuoteSegment[] = []
  let words = 0
  for (const piece of pieces) {
    const tokens = tokenize(piece)
    if (tokens.length === 0) continue
    segments.push({ tokens })
    words += tokens.length
  }
  return { segments, elisions, nonstandardMarkers, words }
}

// ---------------------------------------------------------------------------
// Code masking (offsets preserved)
// ---------------------------------------------------------------------------

const FENCED_CODE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm
const INLINE_CODE = /`[^`\n]+`/g

function blank(match: string): string {
  return match.replace(/[^\n]/g, " ")
}

function maskCode(md: string): string {
  return md.replace(FENCED_CODE, blank).replace(INLINE_CODE, blank)
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** `quoteEnd` is where the `>` lines stop; `end` may extend over the attribution line. */
/** The two kinds of Markdown block the extractor distinguishes. */
const BLOCK_KIND = { PARAGRAPH: "paragraph", BLOCKQUOTE: "blockquote" } as const
type BlockKind = (typeof BLOCK_KIND)[keyof typeof BLOCK_KIND]

type Block = { kind: BlockKind; start: number; end: number; quoteEnd: number }

function isBlockquote(b: Block | null): b is Block {
  return b !== null && b.kind === BLOCK_KIND.BLOCKQUOTE
}

const BLOCKQUOTE_LINE = /^ {0,3}>/
const LIST_ITEM_LINE = /^ {0,3}(?:[-*+]|\d+[.)])\s/
const BLOCKQUOTE_PREFIX = /^ {0,3}> ?/gm

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

/** Does this line hold a citation and no quote opening at all? */
function isAttributionLine(line: string): boolean {
  return !/[«“]/.test(line) && parseCitations(line).length > 0
}

/**
 * Split the (code-masked) body into blocks: a paragraph is a run of non-blank
 * lines; a list-item line starts a new block; a run of `>` lines is a
 * blockquote, and the first non-blank line after it joins it when it is an
 * attribution line (a citation, no quote of its own).
 */
function splitBlocks(md: string, stop: StopCheck): Block[] {
  const blocks: Block[] = []
  const lines = md.split("\n")
  let offset = 0
  let current: Block | null = null
  let pendingAttribution = false

  const close = () => {
    if (current) blocks.push(current)
    current = null
    pendingAttribution = false
  }

  for (const line of lines) {
    stop.tick()
    const start = offset
    const end = offset + line.length
    offset = end + 1

    if (isBlank(line)) {
      if (isBlockquote(current)) {
        pendingAttribution = true
        continue
      }
      close()
      continue
    }

    const quoted = BLOCKQUOTE_LINE.test(line)
    if (isBlockquote(current)) {
      if (quoted && !pendingAttribution) {
        current.end = end
        current.quoteEnd = end
        continue
      }
      if (!quoted && isAttributionLine(line)) {
        current.end = end
        close()
        continue
      }
      close()
    }

    if (quoted) {
      close()
      current = { kind: BLOCK_KIND.BLOCKQUOTE, start, end, quoteEnd: end }
      continue
    }
    if (current && !LIST_ITEM_LINE.test(line)) {
      current.end = end
      current.quoteEnd = end
      continue
    }
    close()
    current = { kind: BLOCK_KIND.PARAGRAPH, start, end, quoteEnd: end }
  }
  close()
  return blocks
}

// ---------------------------------------------------------------------------
// Spans and attribution
// ---------------------------------------------------------------------------

type Span = { form: QuoteForm; open: number; close: number; innerStart: number; innerEnd: number }

/**
 * Top-level « » and “ ” spans of a block (absolute offsets, in source order),
 * the offsets of opening marks that are never closed, and — when the scan
 * gave up — where the unscanned rest of the block starts.
 *
 * Recovery is per quote: an unclosed « (or “) would otherwise swallow every
 * later quote of the block as its content. The scan records it as unbalanced
 * and restarts just after it, so the quotes that follow are still found — and
 * the caller reports the unclosed mark instead of silently checking nothing.
 * Each restart rescans the rest of the block, so at most
 * QUOTE_UNBALANCED_MARKS_MAX_PER_BLOCK restarts are made. The mark that
 * reaches the cap is still reported as unbalanced; the text after it is NOT
 * scanned (neither its quotes nor its marks), and `unscannedFrom` says where
 * it starts so the caller reports it (`unscanned_rest_of_block`) instead of
 * dropping it silently.
 */
function scanSpans(
  text: string,
  base: number,
  stop: StopCheck,
): { spans: Span[]; unbalanced: number[]; unscannedFrom: number | null } {
  const unbalanced: number[] = []
  let spans: Span[] = []
  let from = 0
  for (;;) {
    spans = spans.filter((sp) => sp.open < base + from)
    let depth = 0
    let open = -1
    let curlyOpen = -1
    for (let i = from; i < text.length; i++) {
      stop.tick()
      const ch = text[i]
      if (ch === "«") {
        if (depth === 0 && curlyOpen === -1) open = i
        depth++
      } else if (ch === "»") {
        if (depth === 0) continue
        depth--
        if (depth === 0 && open !== -1) {
          spans.push({ form: QUOTE_FORM.GUILLEMETS, open: base + open, close: base + i, innerStart: base + open + 1, innerEnd: base + i })
          open = -1
        }
      } else if (ch === "“") {
        if (depth === 0 && curlyOpen === -1) curlyOpen = i
      } else if (ch === "”") {
        if (depth === 0 && curlyOpen !== -1) {
          spans.push({ form: QUOTE_FORM.CURLY, open: base + curlyOpen, close: base + i, innerStart: base + curlyOpen + 1, innerEnd: base + i })
          curlyOpen = -1
        }
      }
    }
    // The earliest still-open mark is the one that swallowed the rest.
    const stuck = [open, curlyOpen].filter((o) => o !== -1)
    if (stuck.length === 0) return { spans, unbalanced, unscannedFrom: null }
    const at = Math.min(...stuck)
    unbalanced.push(base + at)
    if (unbalanced.length >= QUOTE_UNBALANCED_MARKS_MAX_PER_BLOCK) {
      // Each recovery rescans the rest of the block: bound the work. The
      // quotes before this mark are kept; the rest is reported unscanned.
      const unscannedFrom = at + 1 < text.length ? base + at + 1 : null
      return { spans: spans.filter((sp) => sp.open < base + at), unbalanced, unscannedFrom }
    }
    from = at + 1
  }
}

type Cite = { ark: string; folio: number; index: number; end: number }

/** The block's citations, sorted by offset (they never overlap, so by end too). */
function citationsIn(text: string, base: number): Cite[] {
  return parseCitations(text)
    .map((c) => ({ ark: c.ark, folio: c.folio, index: base + c.index, end: base + c.index + c.length }))
    .sort((a, b) => a.index - b.index)
}

/** First index in [0, length) whose value is > `bound`, by binary search (`length` when none). */
function firstAbove(length: number, valueAt: (i: number) => number, bound: number): number {
  let lo = 0
  let hi = length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (valueAt(mid) > bound) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * The citation of the `k`-th span of a block (rules in the module header).
 * `spans` are the block's top-level spans and `cites` its citations, both
 * sorted by offset. Top-level spans never overlap, so "no other quote opens
 * in between" only ever concerns the NEXT span (after the quote) or the
 * PREVIOUS one (before it): each rule is one binary search and one compare.
 */
function attribute(k: number, spans: readonly Span[], cites: readonly Cite[]): QuoteCitation | null {
  const span = spans[k]
  const nextOpen = spans[k + 1]?.open ?? Number.POSITIVE_INFINITY
  const prevOpen = spans[k - 1]?.open ?? Number.NEGATIVE_INFINITY

  // 1. The first citation after the closing mark, before the next quote opens.
  const after = cites[firstAbove(cites.length, (i) => cites[i].index, span.close)]
  if (after !== undefined && after.index < nextOpen) return { ark: after.ark, folio: after.folio }

  // 2. The nearest citation ending before the quote, after the previous one opened.
  const before = cites[firstAbove(cites.length, (i) => cites[i].end, span.open) - 1]
  if (before !== undefined && before.index >= prevOpen) return { ark: before.ark, folio: before.folio }

  // 3. The last citation written inside the quote marks.
  const inside = cites[firstAbove(cites.length, (i) => cites[i].end, span.close) - 1]
  if (inside !== undefined && inside.index > span.open) return { ark: inside.ark, folio: inside.folio }

  return null
}

function stripBlockquotePrefix(text: string): string {
  return text.replace(BLOCKQUOTE_PREFIX, "")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function squashWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/**
 * The identity of a quotation for the prior-body rule: same text (whitespace
 * aside), same kind of marks, and the same citation. The quote check skips a
 * quote only when the prior body already held one with the same identity: it
 * was not written this turn. A quote that gained or changed its citation IS
 * new (the agent attributed it this turn), and so is a new quote that happens
 * to be a sub-phrase of an old one. A string, so the prior body's quotes go in
 * a Set and the rule costs one lookup per quote.
 */
export function quoteIdentity(q: Pick<ExtractedQuote, "raw" | "form" | "citation">): string {
  return JSON.stringify([q.form, squashWhitespace(q.raw), q.citation?.ark ?? null, q.citation?.folio ?? null])
}

/** An opening « or “ that is never closed in its block. */
export type UnbalancedQuoteMark = {
  /** Offset of the mark in the body. */
  index: number
  /** The text right after the mark, as written (for the warning excerpt). */
  excerpt: string
}

/** Text the scan did not look at; `index` is where it starts in the body. */
export type UnscannedText = { index: number; excerpt: string }

/** Everything one scan of a note body found. */
export type QuoteScan = {
  /** Every quotation span of the scanned text, in source order. */
  quotes: ExtractedQuote[]
  /**
   * Every opening mark never closed in its block, in source order. The scan
   * recovers past them; the quote check reports them, because
   * the text that follows one cannot be delimited and so cannot be checked.
   */
  unbalanced: UnbalancedQuoteMark[]
  /** The rest of each block given up past QUOTE_UNBALANCED_MARKS_MAX_PER_BLOCK stray marks. */
  unscannedRestOfBlock: UnscannedText[]
  /**
   * Set when `outOfTime` stopped the scan: from `index` on, nothing was
   * scanned (the block being scanned is dropped whole, so no half-attributed
   * quote leaks out).
   */
  stopped: (UnscannedText & { reason: StopReason }) | null
}

export type ScanOptions = {
  /** Ticked inside every loop over the body (deadline.ts). */
  outOfTime: OutOfTime
  /** Characters of text echoed in an unbalanced / unscanned excerpt. */
  excerptChars: number
}

/** One block's quotes, unclosed marks and unscanned rest. Throws QuoteMatchDeadlineError. */
function scanBlock(
  md: string,
  masked: string,
  block: Block,
  excerptChars: number,
  stop: StopCheck,
): Pick<QuoteScan, "quotes" | "unbalanced" | "unscannedRestOfBlock"> {
  const excerpt = (from: number) => md.slice(from, Math.min(block.end, from + excerptChars)).trim()
  const text = masked.slice(block.start, block.end)
  const scanned = scanSpans(text, block.start, stop)
  const spans = scanned.spans.sort((a, b) => a.open - b.open)
  const cites = citationsIn(text, block.start)
  const inBlockquote = block.kind === BLOCK_KIND.BLOCKQUOTE
  const quotes: ExtractedQuote[] = []

  if (spans.length === 0 && inBlockquote) {
    // Tokens come from the code-masked text; `raw` is the body verbatim, so
    // the prior-body rule and the excerpt see what the agent actually wrote.
    // The attribution line is part of the block, not of the quotation.
    const quoted = masked.slice(block.start, block.quoteEnd)
    const parts = segment(stripReferences(stripBlockquotePrefix(quoted)))
    const cite = cites[0]
    if (parts.segments.length > 0) {
      quotes.push({
        raw: stripBlockquotePrefix(md.slice(block.start, block.quoteEnd)).trim(),
        form: QUOTE_FORM.BLOCKQUOTE,
        index: block.start,
        citation: cite ? { ark: cite.ark, folio: cite.folio } : null,
        ...parts,
      })
    }
  } else {
    const unprefix = (s: string) => (inBlockquote ? stripBlockquotePrefix(s) : s)
    for (const [k, span] of spans.entries()) {
      stop.tick()
      const parts = segment(stripReferences(unprefix(masked.slice(span.innerStart, span.innerEnd))))
      if (parts.segments.length === 0) continue
      quotes.push({
        raw: unprefix(md.slice(span.innerStart, span.innerEnd)).trim(),
        form: span.form,
        index: span.open,
        citation: attribute(k, spans, cites),
        ...parts,
      })
    }
  }

  return {
    quotes,
    unbalanced: scanned.unbalanced.map((index) => ({ index, excerpt: excerpt(index + 1) })),
    unscannedRestOfBlock:
      scanned.unscannedFrom === null ? [] : [{ index: scanned.unscannedFrom, excerpt: excerpt(scanned.unscannedFrom) }],
  }
}

/**
 * Scan a note body for its quotations, its unclosed quote marks and the text
 * it gave up on — one pass, bounded by `outOfTime`. Never throws for the
 * deadline: a stopped scan returns what it found before the block it was in,
 * and says where it stopped.
 */
export function scanNoteQuotes(md: string, opts: ScanOptions): QuoteScan {
  const stop = new StopCheck(opts.outOfTime)
  const out: QuoteScan = { quotes: [], unbalanced: [], unscannedRestOfBlock: [], stopped: null }
  let resumeAt = 0
  try {
    const masked = maskCode(md)
    for (const block of splitBlocks(masked, stop)) {
      resumeAt = block.start
      const found = scanBlock(md, masked, block, opts.excerptChars, stop)
      // Not `push(...)`: a dense block holds thousands of quotes.
      for (const q of found.quotes) out.quotes.push(q)
      for (const u of found.unbalanced) out.unbalanced.push(u)
      for (const u of found.unscannedRestOfBlock) out.unscannedRestOfBlock.push(u)
    }
  } catch (err) {
    if (!(err instanceof QuoteMatchDeadlineError)) throw err
    out.stopped = { index: resumeAt, excerpt: md.slice(resumeAt, resumeAt + opts.excerptChars).trim(), reason: err.reason }
  }
  return out
}
