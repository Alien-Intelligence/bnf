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
 *   - `[illisible]` standing for 1..QUOTE_ILLEGIBLE_MAX_WORDS source words;
 *   - for a segment's FIRST word only, the part of a source token after a
 *     French elided prefix (`qu'un` → `un`): a quote may open mid-token.
 * Candidate starts are the positions where the first token can match; the
 * earliest that aligns within the fuzzy budget wins, exact matches preferred.
 *
 * Bounded work (CLAUDE_ERROR_PATTERNS §14): tokenisation, the candidate scan
 * and the alignment itself are loops that tick a StopCheck (deadline.ts), so
 * a caller's deadline stops a long document or a long quote within one
 * stride; the alignment is iterative (no recursion depth tied to the quote's
 * length) and builds its result once, by following back-pointers.
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
import { StopCheck, stopIfOutOfTime, type OutOfTime } from "./deadline"
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

/** A document's tokens in reading order, and each folio's [lo, hi) token range. */
export type SourceDocument = {
  tokens: SourceToken[]
  folioRanges: ReadonlyMap<number, readonly [number, number]>
}

export type QuoteVerdict =
  | { ok: true; matchedFolio: number; fuzzyTokens: number }
  | { ok: false; reason: QuoteWarningReason; foundOnFolio?: number }

export type VerifyOptions = {
  /** Asked every QUOTE_MATCH_DEADLINE_STRIDE steps of the scan and of the alignment. */
  outOfTime: OutOfTime
  citedFolio: number
  marking: OcrCorrectionMarking
  /**
   * The document's badly recognised folios, or `null` when no quality data
   * exists: `correction_on_low_ocr` is then not applied, and the caller must
   * report it as unevaluated (quote-check.ts).
   */
  lowOcrFolios: ReadonlySet<number> | null
}

// ---------------------------------------------------------------------------
// Source tokenisation
// ---------------------------------------------------------------------------

const PRINTED_HYPHENATION = /-\n(?=\p{Ll})/gu
const SENTENCE_END = /[.!?]["»”')\]]*$/u
const UPPER_START = /^["«“'(\[]*\p{Lu}/u
const PARAGRAPH_GAP = /\n[ \t]*\n/

/** One folio's page text → tokens in reading order (folio, breaks, sentence ends), appended to `out`. */
function tokenizeFolio(folio: number, text: string, out: SourceToken[], stop: StopCheck): void {
  const joined = text.replace(PRINTED_HYPHENATION, "")
  // One look-ahead token: a token's sentence end depends on the next one.
  let pending: { raw: string; norm: string; paragraphBreakBefore: boolean } | null = null
  let prevEnd = -1
  const flush = (nextRaw: string | null) => {
    if (pending === null) return
    out.push({
      norm: pending.norm,
      folio,
      paragraphBreakBefore: pending.paragraphBreakBefore,
      sentenceEndAfter: SENTENCE_END.test(pending.raw) && nextRaw !== null && UPPER_START.test(nextRaw),
    })
    pending = null
  }
  let first = true
  for (const m of joined.matchAll(/\S+/g)) {
    stop.tick()
    const raw = m[0]
    const breakBefore = prevEnd !== -1 && PARAGRAPH_GAP.test(joined.slice(prevEnd, m.index))
    prevEnd = m.index + raw.length
    // The next raw token decides the previous token's sentence end, even
    // when it normalises to nothing (a lone `—`), as before.
    flush(raw)
    const norm = normalizeToken(raw)
    if (norm.length === 0) continue
    pending = { raw, norm, paragraphBreakBefore: first || breakBefore }
    first = false
  }
  flush(null)
}

/**
 * The whole document's tokens, folio by folio in map (document) order, with
 * each folio's token range. Stops with QuoteMatchDeadlineError when
 * `outOfTime` says so — checked inside each page, not only between pages.
 */
export function tokenizeFolios(folios: DocumentFolios, outOfTime: OutOfTime): SourceDocument {
  const stop = new StopCheck(outOfTime)
  const tokens: SourceToken[] = []
  const folioRanges = new Map<number, readonly [number, number]>()
  for (const [folio, text] of folios) {
    stopIfOutOfTime(outOfTime)
    const lo = tokens.length
    tokenizeFolio(folio, text, tokens, stop)
    if (tokens.length > lo) folioRanges.set(folio, [lo, tokens.length])
  }
  return { tokens, folioRanges }
}

// ---------------------------------------------------------------------------
// Word comparison
// ---------------------------------------------------------------------------

const FUZZY_MIN_LETTERS = 3

/**
 * Levenshtein distance, bounded: returns `max + 1` as soon as it is exceeded.
 * Banded — only cells within `max` of the diagonal can stay within `max` — so
 * two long tokens (an 18 000-character "word" without spaces) cost
 * O(length × max), not O(length²).
 */
function boundedLevenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const over = max + 1
  // Two rows, allocated once; cells outside the band read as `over`.
  let prev = new Uint32Array(b.length + 1).fill(over)
  let cur = new Uint32Array(b.length + 1).fill(over)
  for (let j = 0; j <= Math.min(b.length, max); j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    const lo = Math.max(1, i - max)
    const hi = Math.min(b.length, i + max)
    cur[0] = i <= max ? i : over
    if (lo > 1) cur[lo - 1] = over
    let rowMin = cur[0]
    for (let j = lo; j <= hi; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost, over)
      if (cur[j] < rowMin) rowMin = cur[j]
    }
    // The next row's band reaches one cell further right: it must read `over` there.
    if (hi < b.length) cur[hi + 1] = over
    if (rowMin > max) return over
    const done = prev
    prev = cur
    cur = done
  }
  return prev[b.length]
}

/**
 * French elision: `qu'un`, `l'imprudence`, `d'abord` are one source token, but
 * a quotation may open right after the apostrophe (« il n'est plus qu'« un
 * amas » »). The part after an elided prefix may therefore stand for the whole
 * token — at the START of a segment only: inside a quote, dropping `l'` is a
 * change to the text.
 */
const ELIDED_PREFIX = /^(?:l|d|j|m|n|s|t|c|qu|jusqu|lorsqu|puisqu|quoiqu)'(.+)$/u

function afterElision(sourceWord: string): string | null {
  return ELIDED_PREFIX.exec(sourceWord)?.[1] ?? null
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

/** One way quote token `i` can consume source tokens from document index `j`. */
type Move = { consumed: number; fuzzy: boolean; bracketed: boolean }

/**
 * The moves of quote token `i` at document index `j`, in preference order (an
 * earlier move wins a tie on fuzzy count): exact (or, for the first token, the
 * part after an elided prefix); else a 2→1 merge, then a fuzzy word; an
 * illegible stands for 1..QUOTE_ILLEGIBLE_MAX_WORDS words, fewest first.
 */
function movesAt(seg: QuoteSegment, doc: readonly SourceToken[], i: number, j: number): Move[] {
  const n = doc.length
  const q = seg.tokens[i]
  if (q.kind === "illegible") {
    const out: Move[] = []
    for (let k = 1; k <= QUOTE_ILLEGIBLE_MAX_WORDS && j + k <= n; k++) out.push({ consumed: k, fuzzy: false, bracketed: false })
    return out
  }
  const s = doc[j].norm
  if (q.norm === s || (i === 0 && q.norm === afterElision(s))) return [{ consumed: 1, fuzzy: false, bracketed: q.bracketed }]
  const out: Move[] = []
  if (j + 1 < n && q.norm === s + doc[j + 1].norm) out.push({ consumed: 2, fuzzy: false, bracketed: q.bracketed })
  if (isFuzzyMatch(q.norm, s)) out.push({ consumed: 1, fuzzy: true, bracketed: q.bracketed })
  return out
}

/** The best way to finish the segment from one state: its fuzzy count, end, and first move. */
type Suffix = { fuzzy: number; end: number; move: Move | null }

/**
 * Align `seg` starting exactly at document index `start`: the alignment with
 * the fewest fuzzy tokens within `budget`, or null.
 *
 * Iterative dynamic programming over states (quote token i, document index j):
 *   1. forward, layer by layer, the states reachable from (0, start) by valid
 *      moves, each with its fewest fuzzy tokens so far — a state already over
 *      the budget is dropped (no path through it can fit), and an empty layer
 *      ends the alignment early (a mismatch);
 *   2. backward, each reachable state's best suffix — fewest fuzzy tokens to
 *      the end of the segment, ties to the earlier move — exactly the choice a
 *      depth-first search in move order would make;
 *   3. the token matches, once, by following the chosen moves from the start.
 * Every state visit ticks `stop`.
 */
function alignAt(
  seg: QuoteSegment,
  doc: readonly SourceToken[],
  start: number,
  budget: number,
  stop: StopCheck,
): Alignment | null {
  const n = doc.length
  const m = seg.tokens.length
  // segment() never yields an empty segment; one built by hand is a bug.
  if (m === 0) throw new Error("alignAt: a segment must have at least one token")

  // 1. Forward: reachable states per layer, with their fewest fuzzy so far.
  const layers: Array<Map<number, number>> = [new Map([[start, 0]])]
  for (let i = 0; i < m; i++) {
    const next = new Map<number, number>()
    for (const [j, soFar] of layers[i]) {
      stop.tick()
      if (j >= n) continue
      for (const mv of movesAt(seg, doc, i, j)) {
        const fuzzy = soFar + (mv.fuzzy ? 1 : 0)
        if (fuzzy > budget) continue
        const to = j + mv.consumed
        const known = next.get(to)
        if (known === undefined || fuzzy < known) next.set(to, fuzzy)
      }
    }
    if (next.size === 0) return null
    layers.push(next)
  }

  // 2. Backward: the best suffix of every reachable state.
  let below = new Map<number, Suffix>()
  for (const j of layers[m].keys()) below.set(j, { fuzzy: 0, end: j, move: null })
  const chosen: Array<Map<number, Suffix>> = new Array(m)
  for (let i = m - 1; i >= 0; i--) {
    const here = new Map<number, Suffix>()
    for (const j of layers[i].keys()) {
      stop.tick()
      if (j >= n) continue
      let best: Suffix | null = null
      for (const mv of movesAt(seg, doc, i, j)) {
        const rest = below.get(j + mv.consumed)
        if (rest === undefined) continue
        const total = rest.fuzzy + (mv.fuzzy ? 1 : 0)
        if (total > budget) continue
        if (best === null || total < best.fuzzy) best = { fuzzy: total, end: rest.end, move: mv }
      }
      if (best !== null) here.set(j, best)
    }
    chosen[i] = here
    below = here
  }

  // 3. Follow the chosen moves from the start.
  const head = chosen[0].get(start)
  if (head === undefined) return null
  const tokens: TokenMatch[] = []
  let j = start
  for (let i = 0; i < m; i++) {
    const step = chosen[i].get(j)
    if (step === undefined || step.move === null) {
      throw new Error(`alignAt: no chosen move at token ${i}, document index ${j} on a path that reached the end`)
    }
    tokens.push({ fuzzy: step.move.fuzzy, bracketed: step.move.bracketed, folio: doc[j].folio })
    j += step.move.consumed
  }
  return { end: head.end, fuzzy: head.fuzzy, tokens }
}

/** Could the segment's first token match at `j`? (cheap pre-filter for starts) */
function canStartAt(seg: QuoteSegment, doc: readonly SourceToken[], j: number): boolean {
  const q = seg.tokens[0]
  if (q.kind === "illegible") return true
  const s = doc[j].norm
  if (q.norm === s || q.norm === afterElision(s)) return true
  if (j + 1 < doc.length && q.norm === s + doc[j + 1].norm) return true
  return isFuzzyMatch(q.norm, s)
}

/** Earliest alignment of `seg` whose start lies in [lo, hi). */
function locate(
  seg: QuoteSegment,
  doc: readonly SourceToken[],
  lo: number,
  hi: number,
  stop: StopCheck,
): SegmentMatch | null {
  const budget = fuzzyBudget(seg)
  for (let j = Math.max(0, lo); j < Math.min(hi, doc.length); j++) {
    stop.tick()
    if (!canStartAt(seg, doc, j)) continue
    const a = alignAt(seg, doc, j, budget, stop)
    if (a) return { start: j, end: a.end, fuzzyTokens: a.fuzzy, tokens: a.tokens }
  }
  return null
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
function elisionWithinReach(doc: readonly SourceToken[], prevEnd: number, start: number): boolean {
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
export function verifyQuote(q: ExtractedQuote, source: SourceDocument, opts: VerifyOptions): QuoteVerdict[] {
  const doc = source.tokens
  const stop = new StopCheck(opts.outOfTime)
  const reasons = new Map<QuoteWarningReason, QuoteVerdict>()
  const flag = (reason: QuoteWarningReason, foundOnFolio?: number) => {
    if (!reasons.has(reason)) {
      reasons.set(reason, foundOnFolio === undefined ? { ok: false, reason } : { ok: false, reason, foundOnFolio })
    }
  }

  if (q.elisions > QUOTE_MAX_ELISIONS) flag(QUOTE_WARNING_REASON.TOO_MANY_ELISIONS)
  if (q.nonstandardMarkers > 0) flag(QUOTE_WARNING_REASON.NONSTANDARD_ELISION_MARKER)

  const cited = source.folioRanges.get(opts.citedFolio)
  const matches: SegmentMatch[] = []

  // Segment 1: on the cited folio, else anywhere in the document.
  const [first, ...rest] = q.segments
  if (!first) {
    // scanNoteQuotes never yields a quote without a segment; a caller that
    // builds one by hand has a bug, and a silent `ok` would hide it.
    throw new Error("verifyQuote: a quote must have at least one segment")
  }
  let primary = cited ? locate(first, doc, cited[0], cited[1], stop) : null
  if (!primary) {
    const elsewhere = locate(first, doc, 0, doc.length, stop)
    if (elsewhere) flag(QUOTE_WARNING_REASON.FOUND_ON_OTHER_FOLIO, doc[elsewhere.start].folio)
    else flag(QUOTE_WARNING_REASON.NOT_IN_CITED_FOLIO)
    primary = elsewhere
  }
  if (!primary) return [...reasons.values()]
  matches.push(primary)

  // Later segments: only after the previous one, in reach, on the same folio.
  let prev = primary
  for (const seg of rest) {
    const next = locate(seg, doc, prev.end, doc.length, stop)
    if (next) {
      const prevFolio = doc[prev.end - 1].folio
      if (doc[next.start].folio !== prevFolio) flag(QUOTE_WARNING_REASON.ELISION_ACROSS_FOLIOS)
      else if (!elisionWithinReach(doc, prev.end, next.start)) flag(QUOTE_WARNING_REASON.ELISION_TOO_FAR)
      matches.push(next)
      prev = next
      continue
    }
    const earlier = locate(seg, doc, 0, prev.start, stop)
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
      if ((t.fuzzy || t.bracketed) && opts.lowOcrFolios !== null && opts.lowOcrFolios.has(t.folio)) {
        flag(QUOTE_WARNING_REASON.CORRECTION_ON_LOW_OCR)
      }
    }
  }

  if (reasons.size > 0) return [...reasons.values()]
  return [{ ok: true, matchedFolio: doc[primary.start].folio, fuzzyTokens }]
}
