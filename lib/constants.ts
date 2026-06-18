// lib/constants.ts
// Cross-cutting string/number constants for the BnF Corpus Research app.
// Rule: no magic numbers in routes, services, or components — import from here.
// See playbook/constants.md.

/** Number of sample documents returned in a CorpusSnapshot. */
export const CORPUS_SAMPLE_SIZE = 25

/**
 * The seq assigned to the first (empty) CorpusVersion created by
 * ProjectService.create(). Invariant 1: every project always has a head.
 */
export const PROJECTS_INITIAL_VERSION_SEQ = 1
