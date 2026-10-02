/**
 * lib/citations/quote-match.ts
 *
 * Pure matcher — aligns an extracted quote (quotes.ts) with the tokenized text
 * of the document it cites and returns the reasons it is unfaithful, or `ok`.
 * No server-only imports: the e2e harness and the audit script run it on the
 * fixture folios in a plain Node process.
 *
 * Source normalisation mirrors the quote's (`normalizeToken`), plus two things
 * only a source has: printed hyphenation `-\n` + lower-case letter is joined,
 * and a blank line marks `paragraphBreakBefore` on the next token.
 *
 * Locating a segment is a semi-global alignment over the document tokens with
 * these operations and no others — a segment can neither insert nor drop words:
 *   - an exact word;
 *   - a fuzzy word (≤ QUOTE_FUZZY_MAX_EDIT edits, quote word ≥ 3 letters, at
 *     most max(1, ceil(QUOTE_FUZZY_WORD_RATIO × words)) per segment — D14);
 *   - a 2→1 merge: one quote word equal to two adjacent source words joined
 *     (the ALTO line split, `répu` / `blique`);
 *   - `[illisible]` standing for 1..QUOTE_ILLEGIBLE_MAX_WORDS source words.
 * Candidate starts are the positions where the first token can match; the
 * earliest that aligns within the fuzzy budget wins, exact matches preferred.
 */

import {
  ELISION_MAX_GAP_WORDS,
  QUOTE_FUZZY_MAX_EDIT,
  QUOTE_FUZZY_WORD_RATIO,
  QUOTE_ILLEGIBLE_MAX_WORDS,
  QUOTE_MAX_ELISIONS,
} from "@/lib/constants"
import type { DocumentFolios } from "@/lib/cluster/folio-text"
import {
  OCR_CORRECTION_MARKING_MODE,
  QUOTE_WARNING_REASON,
  type OcrCorrectionMarking,
  type QuoteWarningReason,
} from "@/models/notes/schema"
import { normalizeToken } from "./quotes"
import type { ExtractedQuote, QuoteSegment } from "./quotes"

export type SourceToken = {
  norm: string
  folio: number
  /** A blank line (or the folio start) precedes this token. */
  paragraphBreakBefore: boolean
  /** This token ends with `.`, `!` or `?` and the next one starts upper-case. */
  sentenceEndAfter: boolean
}

export type QuoteVerdict =
  | { ok: true; matchedFolio: number; fuzzyTokens: number }
  | { ok: false; reason: QuoteWarningReason; foundOnFolio?: number }

export type VerifyOptions = {
  citedFolio: number
  marking: OcrCorrectionMarking
  lowOcrFolios: ReadonlySet<number>
}

// ---------------------------------------------------------------------------
// Source tokenisation
// ---------------------------------------------------------------------------

const PRINTED_HYPHENATION = /-\n(?=\p{Ll})/gu
const SENTENCE_END = /[.!?]["»”')\]]*$/u
const UPPER_START = /^["«“'(\[]*\p{Lu}/u
const PARAGRAPH_GAP = /\n[ \t]*\n/

/** One folio's page text → tokens in reading order (folio, breaks, sentence ends). */
function tokenizeFolio(folio: number, text: string): SourceToken[] {
  const joined = text.replace(PRINTED_HYPHENATION, "")
  const raws: Array<{ raw: string; start: number; end: number }> = []
  for (const m of joined.matchAll(/\S+/g)) {
    raws.push({ raw: m[0], start: m.index, end: m.index + m[0].length })
  }

  const out: SourceToken[] = []
  let first = true
  for (const [i, r] of raws.entries()) {
    const norm = normalizeToken(r.raw)
    if (norm.length === 0) continue
    const prev = raws[i - 1]
    const next = raws[i + 1]
    out.push({
      norm,
      folio,
      paragraphBreakBefore: first || (prev !== undefined && PARAGRAPH_GAP.test(joined.slice(prev.end, r.start))),
      sentenceEndAfter: SENTENCE_END.test(r.raw) && next !== undefined && UPPER_START.test(next.raw),
    })
    first = false
  }
  return out
}

/** The whole document's tokens, folio by folio in map (document) order. */
export function tokenizeFolios(folios: DocumentFolios): SourceToken[] {
  const out: SourceToken[] = []
  for (const [folio, text] of folios) out.push(...tokenizeFolio(folio, text))
  return out
}

// ---------------------------------------------------------------------------
// Word comparison
// ---------------------------------------------------------------------------

const FUZZY_MIN_LETTERS = 3

/** Levenshtein distance, bounded: returns `max + 1` as soon as it is exceeded. */
function boundedLevenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (cur[j] < rowMin) rowMin = cur[j]
    }
    if (rowMin > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

function isFuzzyMatch(quoteWord: string, sourceWord: string): boolean {
  if (quoteWord.length < FUZZY_MIN_LETTERS) return false
  return boundedLevenshtein(quoteWord, sourceWord, QUOTE_FUZZY_MAX_EDIT) <= QUOTE_FUZZY_MAX_EDIT
}

// ---------------------------------------------------------------------------
// Segment alignment
// ---------------------------------------------------------------------------

type TokenMatch = { fuzzy: boolean; bracketed: boolean; folio: number }

type Alignment = { end: number; fuzzy: number; tokens: TokenMatch[] }

type SegmentMatch = {
  start: number
  end: number
  fuzzyTokens: number
  tokens: TokenMatch[]
}

function fuzzyBudget(seg: QuoteSegment): number {
  const words = seg.tokens.filter((t) => t.kind === "word").length
  return Math.max(1, Math.ceil(QUOTE_FUZZY_WORD_RATIO * words))
}

/**
 * Align `seg` starting exactly at document index `start`. Returns the
 * alignment with the fewest fuzzy tokens within `budget`, or null. Memoised
 * on (token index, doc index); the branching is only merges and illegibles.
 */
function alignAt(seg: QuoteSegment, doc: SourceToken[], start: number, budget: number): Alignment | null {
  const n = doc.length
  const memo = new Map<number, Alignment | null>()

  const go = (i: number, j: number): Alignment | null => {
    if (i === seg.tokens.length) return { end: j, fuzzy: 0, tokens: [] }
    if (j >= n) return null
    const key = i * (n + 1) + j
    const cached = memo.get(key)
    if (cached !== undefined) return cached

    let best: Alignment | null = null
    const consider = (consumed: number, fuzzy: boolean, bracketed: boolean) => {
      const rest = go(i + 1, j + consumed)
      if (!rest) return
      const total = rest.fuzzy + (fuzzy ? 1 : 0)
      if (total > budget) return
      if (!best || total < best.fuzzy) {
        best = {
          end: rest.end,
          fuzzy: total,
          tokens: [{ fuzzy, bracketed, folio: doc[j].folio }, ...rest.tokens],
        }
      }
    }

    const q = seg.tokens[i]
    if (q.kind === "illegible") {
      for (let k = 1; k <= QUOTE_ILLEGIBLE_MAX_WORDS && j + k <= n; k++) consider(k, false, false)
    } else {
      const s = doc[j].norm
      if (q.norm === s) consider(1, false, q.bracketed)
      else {
        if (j + 1 < n && q.norm === s + doc[j + 1].norm) consider(2, false, q.bracketed)
        if (isFuzzyMatch(q.norm, s)) consider(1, true, q.bracketed)
      }
    }

    memo.set(key, best)
    return best
  }

  return go(0, start)
}

/** Could the segment's first token match at `j`? (cheap pre-filter for starts) */
function canStartAt(seg: QuoteSegment, doc: SourceToken[], j: number): boolean {
  const q = seg.tokens[0]
  if (q.kind === "illegible") return true
  const s = doc[j].norm
  if (q.norm === s) return true
  if (j + 1 < doc.length && q.norm === s + doc[j + 1].norm) return true
  return isFuzzyMatch(q.norm, s)
}

/** Earliest alignment of `seg` whose start lies in [lo, hi). */
function locate(seg: QuoteSegment, doc: SourceToken[], lo: number, hi: number): SegmentMatch | null {
  const budget = fuzzyBudget(seg)
  for (let j = Math.max(0, lo); j < Math.min(hi, doc.length); j++) {
    if (!canStartAt(seg, doc, j)) continue
    const a = alignAt(seg, doc, j, budget)
    if (a) return { start: j, end: a.end, fuzzyTokens: a.fuzzy, tokens: a.tokens }
  }
  return null
}

/** [lo, hi) token range of each folio, in document order. */
function folioRanges(doc: SourceToken[]): Map<number, [number, number]> {
  const ranges = new Map<number, [number, number]>()
  for (const [i, t] of doc.entries()) {
    const r = ranges.get(t.folio)
    if (r) r[1] = i + 1
    else ranges.set(t.folio, [i, i + 1])
  }
  return ranges
}

// ---------------------------------------------------------------------------
// The elision distance rule (D7)
// ---------------------------------------------------------------------------

/**
 * Is the gap between the previous segment (ending at `prevEnd`, exclusive) and
 * the next one (starting at `start`) a legitimate `[…]`? Same folio is checked
 * by the caller; here: ≤ ELISION_MAX_GAP_WORDS words, no paragraph break, at
 * most one sentence terminator (counted from the previous segment's last token).
 */
function elisionWithinReach(doc: SourceToken[], prevEnd: number, start: number): boolean {
  if (start - prevEnd > ELISION_MAX_GAP_WORDS) return false
  let sentenceEnds = 0
  for (let k = Math.max(prevEnd - 1, 0); k < start; k++) {
    if (k >= prevEnd && doc[k].paragraphBreakBefore) return false
    if (doc[k].sentenceEndAfter) sentenceEnds++
  }
  if (doc[start].paragraphBreakBefore) return false
  return sentenceEnds <= 1
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Every applicable reason the quote is unfaithful to the document, in rule
 * order, or a single `ok` verdict. Returning them all at once lets the agent
 * fix a quote in one rewrite rather than one warning per turn.
 */
export function verifyQuote(q: ExtractedQuote, doc: SourceToken[], opts: VerifyOptions): QuoteVerdict[] {
  const reasons = new Map<QuoteWarningReason, QuoteVerdict>()
  const flag = (reason: QuoteWarningReason, foundOnFolio?: number) => {
    if (!reasons.has(reason)) {
      reasons.set(reason, foundOnFolio === undefined ? { ok: false, reason } : { ok: false, reason, foundOnFolio })
    }
  }

  if (q.elisions > QUOTE_MAX_ELISIONS) flag(QUOTE_WARNING_REASON.TOO_MANY_ELISIONS)
  if (q.nonstandardMarkers > 0) flag(QUOTE_WARNING_REASON.NONSTANDARD_ELISION_MARKER)

  const ranges = folioRanges(doc)
  const cited = ranges.get(opts.citedFolio)
  const matches: SegmentMatch[] = []

  // Segment 1: on the cited folio, else anywhere in the document.
  const [first, ...rest] = q.segments
  if (!first) {
    // extractQuotes never yields a quote without a segment; a caller that
    // builds one by hand has a bug, and a silent `ok` would hide it.
    throw new Error("verifyQuote: a quote must have at least one segment")
  }
  let primary = cited ? locate(first, doc, cited[0], cited[1]) : null
  if (!primary) {
    const elsewhere = locate(first, doc, 0, doc.length)
    if (elsewhere) flag(QUOTE_WARNING_REASON.FOUND_ON_OTHER_FOLIO, doc[elsewhere.start].folio)
    else flag(QUOTE_WARNING_REASON.NOT_IN_CITED_FOLIO)
    primary = elsewhere
  }
  if (!primary) return [...reasons.values()]
  matches.push(primary)

  // Later segments: only after the previous one, in reach, on the same folio.
  let prev = primary
  for (const seg of rest) {
    const next = locate(seg, doc, prev.end, doc.length)
    if (next) {
      const prevFolio = doc[prev.end - 1].folio
      if (doc[next.start].folio !== prevFolio) flag(QUOTE_WARNING_REASON.ELISION_ACROSS_FOLIOS)
      else if (!elisionWithinReach(doc, prev.end, next.start)) flag(QUOTE_WARNING_REASON.ELISION_TOO_FAR)
      matches.push(next)
      prev = next
      continue
    }
    const earlier = locate(seg, doc, 0, prev.start)
    if (earlier) {
      flag(QUOTE_WARNING_REASON.ELISION_OUT_OF_ORDER)
      matches.push(earlier)
    } else {
      flag(QUOTE_WARNING_REASON.NOT_IN_CITED_FOLIO)
    }
  }

  // Corrections: unmarked in bracketed mode; any at all on a low-OCR folio.
  let fuzzyTokens = 0
  for (const m of matches) {
    fuzzyTokens += m.fuzzyTokens
    for (const t of m.tokens) {
      if (t.fuzzy && !t.bracketed && opts.marking === OCR_CORRECTION_MARKING_MODE.BRACKETED_WORD) {
        flag(QUOTE_WARNING_REASON.UNMARKED_CORRECTION)
      }
      if ((t.fuzzy || t.bracketed) && opts.lowOcrFolios.has(t.folio)) {
        flag(QUOTE_WARNING_REASON.CORRECTION_ON_LOW_OCR)
      }
    }
  }

  if (reasons.size > 0) return [...reasons.values()]
  return [{ ok: true, matchedFolio: doc[primary.start].folio, fuzzyTokens }]
}
