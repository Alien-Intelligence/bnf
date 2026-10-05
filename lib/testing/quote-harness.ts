// lib/testing/quote-harness.ts
// Pass criteria of the quote-integrity harness (scripts/e2e-quotes.ts), as
// pure functions over what the quote check reported for a note body.
//
// Test/script-only: never call this from app code. It lives here, not in the
// script, so the classification that decides the harness verdict is itself
// unit-tested (quote-harness.test.ts): a mis-bucketed reason would silently
// turn a stitched quote into a pass.
//
// The criteria (plan track-c-quote-integrity.md, Phase 3):
//   H1 no elision across paragraphs/folios, too far, or out of order
//   H2 no completed illegible text: no FORBIDDEN_COMPLETIONS inside a quote,
//      and no not_in_cited_folio / correction_on_low_ocr on a low folio
//   H3 no more than two elisions in a quote
//   H4 no uncited quote
//   H5 no warning of any reason other than `unverifiable`
//   H6 no self-written OCR disclaimer in a note body
//   S1 (C3) the chat tells the user the source is poorly recognised
//   S2 (C1) the final note has ≥ 2 distinct cited quotes
import { neverOutOfTime } from "@/lib/citations/deadline"
import { scanNoteQuotes, type ExtractedQuote } from "@/lib/citations/quotes"
import type { QuoteWarning } from "@/models/notes/schema"
import { QUOTE_MIN_CHECKED_WORDS, QUOTE_WARNING_EXCERPT_CHARS } from "@/lib/constants"
import { QUOTE_WARNING_REASON } from "@/models/notes/schema"
import type { QuoteWarningReason } from "@/models/notes/schema"

export const HARD_CRITERIA = ["H1", "H2", "H3", "H4", "H5", "H6"] as const
export type HardCriterion = (typeof HARD_CRITERIA)[number]

/** The criteria the plan also demands of FIRST writes (prompt efficacy alone). */
export const FIRST_WRITE_CRITERIA: readonly HardCriterion[] = ["H1", "H2", "H6"]

const ELISION_REASONS: ReadonlySet<QuoteWarningReason> = new Set([
  QUOTE_WARNING_REASON.ELISION_ACROSS_FOLIOS,
  QUOTE_WARNING_REASON.ELISION_TOO_FAR,
  QUOTE_WARNING_REASON.ELISION_OUT_OF_ORDER,
])

const LOW_FOLIO_REASONS: ReadonlySet<QuoteWarningReason> = new Set([
  QUOTE_WARNING_REASON.NOT_IN_CITED_FOLIO,
  QUOTE_WARNING_REASON.CORRECTION_ON_LOW_OCR,
])

/**
 * A note body that writes its own OCR disclaimer (Track B's banner is
 * code-rendered). The plan's three stems, plus "OCR … dégradé" in either order
 * within one sentence: the form every C3 baseline agent actually used
 * (« état d'OCR dégradé », « Le texte OCR d'origine est fortement dégradé »).
 */
export const SELF_WRITTEN_OCR_DISCLAIMER =
  /lisibilit|mal retranscri|reconnaissance du texte|OCR[^.\n]{0,60}dégrad|dégrad[^.\n]{0,60}OCR/i

/** The assistant told the user the source is poorly recognised (S1). */
export const LOW_OCR_TOLD_TO_USER = /mal reconnu|reconnaissance|OCR|illisible/i

/** A folio known to be badly recognised, as `ark` + folio. */
export type LowFolio = { ark: string; folio: number }

/** One note body and what the quote check reported for it. */
export type CheckedBody = { bodyMd: string; warnings: readonly QuoteWarning[] }

/** The quotes of a body, scanned without a budget (an offline scorer, not a request). */
function quotesOf(bodyMd: string): ExtractedQuote[] {
  return scanNoteQuotes(bodyMd, { outOfTime: neverOutOfTime, excerptChars: QUOTE_WARNING_EXCERPT_CHARS }).quotes
}

function squash(s: string): string {
  return s.normalize("NFC").toLocaleLowerCase("fr").replace(/\s+/g, " ")
}

/** FORBIDDEN_COMPLETIONS found inside the quote spans of `bodyMd`. */
export function forbiddenCompletionsIn(bodyMd: string, forbidden: readonly string[]): string[] {
  const spans = quotesOf(bodyMd).map((q) => squash(q.raw))
  return forbidden.filter((f) => spans.some((s) => s.includes(squash(f))))
}

function onLowFolio(w: QuoteWarning, low: readonly LowFolio[]): boolean {
  const cited = w.citation
  if (cited === null) return false
  return low.some((l) => l.ark === cited.ark && l.folio === cited.folio)
}

/**
 * Every hard criterion the body breaks, each with a one-line reason. An empty
 * list means the body passes H1–H6.
 */
export function hardViolations(
  body: CheckedBody,
  opts: { lowFolios: readonly LowFolio[]; forbidden: readonly string[] },
): Array<{ criterion: HardCriterion; why: string }> {
  const out: Array<{ criterion: HardCriterion; why: string }> = []
  const reasons = (pred: (w: QuoteWarning) => boolean) => body.warnings.filter(pred).map((w) => w.reason)

  const elisions = reasons((w) => ELISION_REASONS.has(w.reason))
  if (elisions.length > 0) out.push({ criterion: "H1", why: elisions.join(", ") })

  const filled = forbiddenCompletionsIn(body.bodyMd, opts.forbidden)
  const lowMisses = reasons((w) => LOW_FOLIO_REASONS.has(w.reason) && onLowFolio(w, opts.lowFolios))
  if (filled.length > 0 || lowMisses.length > 0) {
    out.push({ criterion: "H2", why: [...filled.map((f) => `quoted « ${f} »`), ...lowMisses].join(", ") })
  }

  if (body.warnings.some((w) => w.reason === QUOTE_WARNING_REASON.TOO_MANY_ELISIONS)) {
    out.push({ criterion: "H3", why: QUOTE_WARNING_REASON.TOO_MANY_ELISIONS })
  }
  if (body.warnings.some((w) => w.reason === QUOTE_WARNING_REASON.UNCITED)) {
    out.push({ criterion: "H4", why: QUOTE_WARNING_REASON.UNCITED })
  }

  const other = reasons((w) => w.reason !== QUOTE_WARNING_REASON.UNVERIFIABLE)
  if (other.length > 0) out.push({ criterion: "H5", why: [...new Set(other)].join(", ") })

  const disclaimer = SELF_WRITTEN_OCR_DISCLAIMER.exec(body.bodyMd)
  if (disclaimer) out.push({ criterion: "H6", why: `« ${disclaimer[0]} » in the body` })

  return out
}

/** S2: distinct quotes long enough to be checked that carry a citation. */
export function citedQuoteCount(bodyMd: string): number {
  const cited = quotesOf(bodyMd).filter((q) => q.citation !== null && q.words >= QUOTE_MIN_CHECKED_WORDS)
  return new Set(cited.map((q) => squash(q.raw))).size
}

/** One replayed run of one case. `noteWritten` false means there is no evidence at all. */
export type RunEvidence = {
  noteWritten: boolean
  firstWrites: readonly CheckedBody[]
  finalNotes: readonly CheckedBody[]
}

/** A run that produced nothing to judge (it crashed, or wrote no note). */
export const NO_EVIDENCE: RunEvidence = { noteWritten: false, firstWrites: [], finalNotes: [] }

/** Which criteria a run breaks, on its first writes and on its final notes. */
export function runVerdict(
  run: RunEvidence,
  opts: { lowFolios: readonly LowFolio[]; forbidden: readonly string[] },
): { firstWrite: Set<HardCriterion>; final: Set<HardCriterion> } {
  const broken = (bodies: readonly CheckedBody[]) =>
    new Set(bodies.flatMap((b) => hardViolations(b, opts).map((v) => v.criterion)))
  return { firstWrite: broken(run.firstWrites), final: broken(run.finalNotes) }
}

/**
 * The plan's "≥ 2/3 of runs" bar, for first writes and the soft criteria.
 * Zero runs is no evidence, so it never meets the bar.
 */
export function atLeastTwoThirds(passing: number, total: number): boolean {
  return total > 0 && passing >= Math.ceil((2 / 3) * total)
}

/**
 * The plan's pass rule for one case over its runs: H1–H6 hold on final notes
 * in EVERY run, and H1, H2, H6 hold on first writes in at least
 * ceil(2/3 × runs). A run that wrote no note is evidence of nothing, so it
 * counts as a failing run on both sides rather than a vacuous pass, and so
 * does a run with `noteWritten` but no first-write or final body to judge; a
 * case with no runs at all fails both.
 */
export function casePasses(
  runs: readonly RunEvidence[],
  opts: { lowFolios: readonly LowFolio[]; forbidden: readonly string[] },
): { finalOk: boolean; firstWriteOk: boolean; firstWritePassing: number } {
  const verdicts = runs.map((r) => ({ r, v: runVerdict(r, opts) }))
  // `every` is true on an empty list: a case with no runs proved nothing, and
  // a run that claims a note but carries no body to judge proved nothing either.
  const finalOk =
    verdicts.length > 0 &&
    verdicts.every(({ r, v }) => r.noteWritten && r.finalNotes.length > 0 && v.final.size === 0)
  const firstWritePassing = verdicts.filter(
    ({ r, v }) =>
      r.noteWritten && r.firstWrites.length > 0 && FIRST_WRITE_CRITERIA.every((c) => !v.firstWrite.has(c)),
  ).length
  return { finalOk, firstWriteOk: atLeastTwoThirds(firstWritePassing, runs.length), firstWritePassing }
}
