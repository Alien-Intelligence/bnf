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
// quote check; these are the domain values of its result. Wire names are
// snake_case because they travel in the tool result the model reads.
// ---------------------------------------------------------------------------

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
  TOO_MANY_SOURCES: "too_many_sources",
} as const
export type QuoteUnverifiableCause =
  (typeof QUOTE_UNVERIFIABLE_CAUSE)[keyof typeof QUOTE_UNVERIFIABLE_CAUSE]

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

/** Agent-facing French guidance per reason (rendered into `detail`). */
export const QUOTE_WARNING_DETAIL: Record<QuoteWarningReason, string> = {
  [QUOTE_WARNING_REASON.UNCITED]:
    "Citation sans référence : ajoute juste après le `[[ark|label|folio]]` du passage " +
    "d'où elle vient, ou retire les guillemets et paraphrase.",
  [QUOTE_WARNING_REASON.NOT_IN_CITED_FOLIO]:
    "Ce texte ne figure pas sur le folio cité. Recopie le texte exact du passage, ou " +
    "paraphrase sans guillemets.",
  [QUOTE_WARNING_REASON.FOUND_ON_OTHER_FOLIO]:
    "Ce texte figure sur un autre folio que celui cité : corrige le folio de la référence.",
  [QUOTE_WARNING_REASON.ELISION_ACROSS_FOLIOS]:
    "Le `[…]` relie des extraits de folios différents : fais-en des citations distinctes, " +
    "chacune avec sa référence.",
  [QUOTE_WARNING_REASON.ELISION_TOO_FAR]:
    "Le `[…]` saute plus que quelques mots d'une même phrase ou de deux phrases voisines : " +
    "scinde en citations distinctes reliées par tes propres mots.",
  [QUOTE_WARNING_REASON.ELISION_OUT_OF_ORDER]:
    "Les extraits reliés par `[…]` ne sont pas dans l'ordre du document : scinde la citation.",
  [QUOTE_WARNING_REASON.TOO_MANY_ELISIONS]:
    "Plus de deux `[…]` dans une même citation : scinde-la ou paraphrase.",
  [QUOTE_WARNING_REASON.NONSTANDARD_ELISION_MARKER]:
    "Signale une coupure par `[…]`, jamais par `(…)`.",
  [QUOTE_WARNING_REASON.UNMARKED_CORRECTION]:
    "Un mot diffère de l'OCR sans être signalé : mets le mot corrigé entre crochets, ou " +
    "recopie l'OCR tel quel.",
  [QUOTE_WARNING_REASON.CORRECTION_ON_LOW_OCR]:
    "Ce folio est mal reconnu : ne corrige rien, recopie l'OCR tel quel ou écris `[illisible]`.",
  [QUOTE_WARNING_REASON.UNVERIFIABLE]:
    "Contrôle impossible (cause indiquée) : relis le passage avec `rag_get_text` avant de " +
    "conserver cette citation.",
}
