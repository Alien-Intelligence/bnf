// models/notes/schema.ts
// Re-exported Prisma types + composite shapes for Note, NoteVersion, and Citation.
// No `import "server-only"` — schema is referenced by both client and server.
import type { Note, NoteVersion, Citation } from "@/lib/generated/prisma/client"

export type { Note, NoteVersion, Citation }

export type NoteWithCitations = Note & { citations: Citation[] }
export type NoteListItem = Pick<Note, "id" | "title" | "updatedAt" | "citationCount" | "pinned" | "createdAt">

/** Lightweight row returned by GET /api/notes/:nid/versions */
export type NoteVersionListItem = Pick<NoteVersion, "id" | "seq" | "createdAt">

// ---------------------------------------------------------------------------
// Quote integrity (feedback-2026-09-29 #7 / #8). The agent's note writes run a
// quote check; these are the domain values and the wire shape of its result,
// which the note tools return and tool_call.output persists. Wire names are
// snake_case because they travel in the tool result the model reads. The
// agent-facing French guidance per reason is server-only prose and lives with
// the prompts (lib/agent/prompts/quote-warnings.ts), not in this client-shared
// file.
// ---------------------------------------------------------------------------

/** How a quotation is marked in a note body (plan D8). */
export const QUOTE_FORM = {
  GUILLEMETS: "guillemets",
  CURLY: "curly",
  BLOCKQUOTE: "blockquote",
} as const
export type QuoteForm = (typeof QUOTE_FORM)[keyof typeof QUOTE_FORM]

/** Why a quoted span is reported as unfaithful to the folio it cites. */
export const QUOTE_WARNING_REASON = {
  UNCITED: "uncited_quote",
  NOT_IN_CITED_FOLIO: "not_in_cited_folio",
  FOUND_ON_OTHER_FOLIO: "found_on_other_folio",
  ELISION_ACROSS_FOLIOS: "elision_across_folios",
  ELISION_TOO_FAR: "elision_too_far",
  ELISION_OUT_OF_ORDER: "elision_out_of_order",
  TOO_MANY_ELISIONS: "too_many_elisions",
  NONSTANDARD_ELISION_MARKER: "nonstandard_elision_marker",
  UNMARKED_CORRECTION: "unmarked_correction",
  CORRECTION_ON_LOW_OCR: "correction_on_low_ocr",
  /** An opening « or “ that is never closed: what follows cannot be delimited. */
  UNBALANCED_QUOTE_MARK: "unbalanced_quote_mark",
  UNVERIFIABLE: "unverifiable",
} as const
export type QuoteWarningReason =
  (typeof QUOTE_WARNING_REASON)[keyof typeof QUOTE_WARNING_REASON]

/** Why a quote could not be checked at all (`unverifiable` only). */
export const QUOTE_UNVERIFIABLE_CAUSE = {
  ENTRY_NOT_FOUND: "entry_not_found",
  FOLIO_ABSENT: "folio_absent",
  LOOKUP_FAILED: "lookup_failed",
  BUDGET_EXCEEDED: "budget_exceeded",
  /** The turn was cancelled while the check was running. */
  CANCELLED: "cancelled",
  TOO_MANY_SOURCES: "too_many_sources",
} as const
export type QuoteUnverifiableCause =
  (typeof QUOTE_UNVERIFIABLE_CAUSE)[keyof typeof QUOTE_UNVERIFIABLE_CAUSE]

/**
 * Outcome of one quote check. `partial` when any quote is `unverifiable` or a
 * rule could not be evaluated at all (`unevaluated_rules`); `failed` when the
 * check itself broke after the write (the note tools set it).
 */
export const QUOTE_CHECK_STATUS = {
  COMPLETE: "complete",
  PARTIAL: "partial",
  FAILED: "failed",
} as const
export type QuoteCheckStatus =
  (typeof QUOTE_CHECK_STATUS)[keyof typeof QUOTE_CHECK_STATUS]

/**
 * How a corrected OCR word is marked inside a quote. `bracketed_word` writes
 * `[maison]` for an OCR `ma:son`; `silent` writes the corrected word as is. The
 * prompt, the tool hint and the guard all follow one constant
 * (`OCR_CORRECTION_MARKING` in lib/constants.ts).
 */
export const OCR_CORRECTION_MARKING_MODE = {
  BRACKETED_WORD: "bracketed_word",
  SILENT: "silent",
} as const
export type OcrCorrectionMarking =
  (typeof OCR_CORRECTION_MARKING_MODE)[keyof typeof OCR_CORRECTION_MARKING_MODE]

/** The `[[ark|label|folio]]` a quote is attributed to. */
export type QuoteCitation = { ark: string; folio: number }

/** One unfaithful (or unverifiable) quote, as the note tools report it. */
export type QuoteWarning = {
  /** The first QUOTE_WARNING_EXCERPT_CHARS characters of the quote, as written. */
  quote: string
  citation: QuoteCitation | null
  reason: QuoteWarningReason
  /** Only for `unverifiable`. */
  cause?: QuoteUnverifiableCause
  found_on_folio?: number
  /** What the agent should do (server-rendered French guidance). */
  detail: string
}

/** The result of checking the quotes of one note write. */
export type QuoteCheckResult = {
  status: QuoteCheckStatus
  /** Quotes in scope (long enough, not already in the prior body). */
  checked: number
  warnings: QuoteWarning[]
  /**
   * Rules that could not be applied to ANY checked quote — today
   * `correction_on_low_ocr` until Track B's per-folio quality index is wired.
   * Non-empty forces `status: partial`.
   */
  unevaluated_rules: QuoteWarningReason[]
}
