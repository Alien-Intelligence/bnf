// lib/corpus/filter-where.ts
// The corpus filter → Prisma WHERE translation: the ONE place the corpus
// filter semantics live (Decision 4's `not` rule included), built once per
// read by CorpusService and executed by CorpusQueries, which only runs the
// predicates it is handed. Also the numérisation fold the snapshot shows.
// Pure: no I/O.
import type { Prisma } from "@/lib/generated/prisma/client"
import { arkKindWhere } from "@/lib/documents/ark-kind"
import type { CorpusSnapshot, CorpusWherePredicates } from "@/models/corpus/schema"
import type { CorpusFilterSet, CorpusNotFilterSet } from "@/models/corpus/types"
import {
  DOCUMENT_RESOLVE_STATUS,
  INDEXATION_OUTCOME,
  INGESTION_CLASS,
  INGESTION_IMAGE_LIKE_TYPES,
  NON_LATIN_SCRIPT_LANG_CODES,
  classifyIngestion,
  type IndexationOutcome,
} from "@/models/documents/schema"

// Prisma WHERE fragment matching one ingestion class — the SQL mirror of
// classifyIngestion(). digitized ⇔ iiifManifestUrl is set (Gallica-only);
// "no OCR" is false OR null (unknown counts as none, as in the classifier).
// Returns null for an unrecognised class so callers can filter it out.
function ingestClassWhere(cls: string): Prisma.DocumentWhereInput | null {
  const imageLike = [...INGESTION_IMAGE_LIKE_TYPES]
  const noOcr: Prisma.DocumentWhereInput["OR"] = [
    { ocrAvailable: false },
    { ocrAvailable: null },
  ]
  switch (cls) {
    // Every arm is two-valued (never SQL NULL): `ocr_available = true` and
    // `doc_type IN (…)` are NULL on a NULL column, which `NOT(…)` keeps NULL
    // and so drops the row from BOTH sides of a `not` (Decision 4). The
    // explicit `not: null` makes them FALSE instead — the classifier's reading
    // (a null OCR flag is "no OCR", a null type is not image-like).
    case INGESTION_CLASS.OCR:
      return { iiifManifestUrl: { not: null }, ocrAvailable: { not: null, equals: true } }
    case INGESTION_CLASS.VISION:
      return { iiifManifestUrl: { not: null }, docType: { not: null, in: imageLike }, OR: noOcr }
    case INGESTION_CLASS.SANS_TEXTE:
      // `notIn` compiles to SQL NOT IN, which is null-hostile: a row with a
      // NULL doc_type does not satisfy it. classifyIngestion() reads that same
      // row as sans_texte — a null type is not image-like — so the two
      // disagreed, and the filter quietly omitted documents the card counted.
      // Verified against the dev database: `notIn` returns only non-null rows.
      // Spell the null arm out. `in` (VISION, below) needs no such care: it
      // excludes nulls, and so does the classifier.
      return {
        iiifManifestUrl: { not: null },
        AND: [
          { OR: [{ docType: null }, { docType: { notIn: imageLike } }] },
          { OR: noOcr },
        ],
      }
    case INGESTION_CLASS.NON_NUMERISE:
      return { iiifManifestUrl: null }
    default:
      return null
  }
}

// The set a document must fall in to read as `excluded` — never sent to the
// index because there was nothing in it to index. The SQL mirror of the
// `!isIngestableClass(cls) && confident` arm of classifyOutcome(), which is
// itself a mirror of IngestService._partitionByIngestability(). All three move
// together.
//
// `non_numerise` is always confident (nothing to resolve — there is no scan).
// `sans_texte` is a verdict about a digitized document, so it only counts once
// the row is RESOLVED: an unresolved stub may still turn out to carry OCR, and
// calling it excluded would assert a permanent absence from a pending lookup.
function excludedClassWhere(paidOcrEnabled: boolean): Prisma.DocumentWhereInput {
  const sansTexte = ingestClassWhere(INGESTION_CLASS.SANS_TEXTE)
  const nonNumerise = ingestClassWhere(INGESTION_CLASS.NON_NUMERISE)
  // Both classes are literals of INGESTION_CLASS, so ingestClassWhere never
  // returns null here; the guard keeps that a type fact rather than a comment.
  if (sansTexte === null || nonNumerise === null) {
    throw new Error("excludedClassWhere: unknown ingestion class")
  }
  // The paid-OCR carve-out, mirroring _partitionByIngestability: with paid OCR
  // on, a Latin-script sans_texte document is NOT excluded — it goes to the
  // paidOcr bucket and is sent once the spend is confirmed. Only the non-Latin
  // ones (which Mistral mangles, see isLatinScriptLang) stay excluded. A null
  // lang is presumed Latin, exactly as the classifier presumes it, so it must
  // NOT match here — `in` already excludes nulls, which is the behaviour we
  // want for once.
  // `lang IS NOT NULL` before `lang IN (…)`, and it is load-bearing: IN yields
  // NULL for a null lang, so the whole arm would be NULL, `NOT(arm)` would be
  // NULL too, and the row would match NEITHER `excluded` nor `not_ingested` —
  // silently dropping it out of a partition the header count depends on. The
  // guard makes the arm FALSE instead, which is also the right answer: a null
  // lang is presumed Latin (isLatinScriptLang), hence paid-OCR eligible, hence
  // not excluded. Measured: 11 documents across two dev projects fell through
  // this gap before the guard.
  // NOTE the AND is MERGED, not replaced: `sansTexte` already carries its own
  // AND array (the docType and no-OCR arms), and spreading then re-declaring
  // `AND` would silently drop both, leaving "any resolved digitized document in
  // a non-Latin language" — a much larger set that still partitions cleanly, so
  // the sum check would not catch it.
  const sansTexteAnd = Array.isArray(sansTexte.AND) ? sansTexte.AND : []
  const sansTexteExcluded: Prisma.DocumentWhereInput = paidOcrEnabled
    ? {
        ...sansTexte,
        resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
        AND: [
          ...sansTexteAnd,
          // `lang IS NOT NULL` before `lang IN (…)`, and it is load-bearing: IN
          // yields NULL for a null lang, so the arm would be NULL, `NOT(arm)`
          // NULL too, and the row would match NEITHER `excluded` nor
          // `not_ingested` — dropping out of a partition the header count
          // depends on. FALSE is also the right answer: a null lang is presumed
          // Latin (isLatinScriptLang), hence paid-OCR eligible, hence not
          // excluded. Measured: 11 documents across two dev projects fell
          // through this gap before the guard.
          { lang: { not: null } },
          { lang: { in: [...NON_LATIN_SCRIPT_LANG_CODES] } },
        ],
      }
    : { ...sansTexte, resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED }

  return { OR: [nonNumerise, sansTexteExcluded] }
}

/**
 * Prisma WHERE fragment matching one indexation outcome — the SQL mirror of
 * classifyOutcome(). Returns null for an unrecognised state so callers can
 * filter it out, exactly as ingestClassWhere() does.
 *
 * The four fragments are mutually exclusive and cover the table, so OR-ing all
 * four is the same set as no filter at all. That is what makes the outcome
 * counts in snapshot() sum to `total`.
 */
function outcomeWhere(
  state: string,
  paidOcrEnabled: boolean,
): Prisma.DocumentWhereInput | null {
  switch (state) {
    case INDEXATION_OUTCOME.INDEXED:
      // indexError may be set alongside — that is a warning on an indexed doc,
      // not a failure. See indexationWarning().
      return { indexedAt: { not: null } }
    case INDEXATION_OUTCOME.FAILED:
      return { indexedAt: null, indexError: { not: null } }
    case INDEXATION_OUTCOME.EXCLUDED:
      return {
        indexedAt: null,
        indexError: null,
        ...excludedClassWhere(paidOcrEnabled),
      }
    case INDEXATION_OUTCOME.NOT_INGESTED:
      return {
        indexedAt: null,
        indexError: null,
        NOT: excludedClassWhere(paidOcrEnabled),
      }
    default:
      return null
  }
}

/** Contains-ANY over a Document text column. */
function documentContainsAny(column: "title" | "author", values: string[]): Prisma.DocumentWhereInput {
  return { OR: values.map((v) => documentContains(column, v)) }
}

/** ILIKE over one nullable text column, FALSE (not NULL) on a NULL column. */
function documentContains(column: "title" | "author" | "excerpt", value: string): Prisma.DocumentWhereInput {
  const filter = { not: null, contains: value, mode: "insensitive" as const }
  switch (column) {
    case "title":
      return { title: filter }
    case "author":
      return { author: filter }
    case "excerpt":
      return { excerpt: filter }
  }
}

/**
 * Per dimension a corpus `not` can name: when it is used, what makes a
 * document's value KNOWN for it, and the unknown complement (Decision 4). A
 * document whose value is unknown for a dimension the exclusion names is never
 * matched by `not`: it is neither listed nor removed, and every read and dry
 * run reports it (`notUnknown`). `kind` and `outcome` are always known
 * (every document has a record kind and an indexation outcome), so they have
 * no entry; `q` is unknown only when the document has no text at all; the
 * ingestion class is unknown until the document is resolved.
 */
const CORPUS_NOT_PRESENCE: ReadonlyArray<{
  dimension: keyof CorpusNotFilterSet | "year" | "q"
  used: (f: CorpusNotFilterSet) => boolean
  known: Prisma.DocumentWhereInput
  unknown: Prisma.DocumentWhereInput
}> = [
  { dimension: "type", used: (f) => !!f.type?.length, known: { docType: { not: null } }, unknown: { docType: null } },
  { dimension: "lang", used: (f) => !!f.lang?.length, known: { lang: { not: null } }, unknown: { lang: null } },
  { dimension: "source", used: (f) => !!f.source?.length, known: { source: { not: null } }, unknown: { source: null } },
  { dimension: "title", used: (f) => !!f.title?.length, known: { title: { not: null } }, unknown: { title: null } },
  { dimension: "creator", used: (f) => !!f.creator?.length, known: { author: { not: null } }, unknown: { author: null } },
  {
    // With `undated: true` the year dimension is two-valued (range OR
    // undated): an undated document is then MATCHED, not unknown — the
    // buffer's rule (models/buffer/service.ts), so a saved set means the same
    // before and after a commit.
    dimension: "year",
    used: (f) => (f.yearFrom !== undefined || f.yearTo !== undefined) && f.undated !== true,
    known: { year: { not: null } },
    unknown: { year: null },
  },
  {
    dimension: "q",
    used: (f) => !!f.q && f.q.trim().length > 0,
    known: { OR: [{ title: { not: null } }, { author: { not: null } }, { excerpt: { not: null } }] },
    unknown: { title: null, author: null, excerpt: null },
  },
  {
    dimension: "ingest",
    used: (f) => !!f.ingest?.length,
    known: { resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED },
    unknown: { resolveStatus: { not: DOCUMENT_RESOLVE_STATUS.RESOLVED } },
  },
]

/** The presence entries a `not` filter set uses. */
export function corpusNotPresence(not: CorpusNotFilterSet) {
  return CORPUS_NOT_PRESENCE.filter((p) => p.used(not))
}

/**
 * Translate a CorpusFilterSet into the two Prisma WHERE predicates every corpus
 * read shares:
 *   - `sharedWhere`   — version membership AND all active filter clauses. Spans
 *                       all members (including pending/failed stubs) except
 *                       where a type/lang/year/q filter naturally excludes them.
 *   - `resolvedWhere` — `sharedWhere` further constrained to RESOLVED documents.
 *                       Used for the type/lang/period facets and the period
 *                       histogram, which are meaningless for unresolved stubs.
 *
 * Extracted from `snapshot()` so `list()`, `crossFacets()`, and
 * `removeByFilter()` resolve membership identically — there is exactly one
 * filter→SQL translation in the codebase. Pure: no I/O, deterministic in its
 * inputs.
 *
 * Year semantics — the SAME as the buffer's: a yearFrom/yearTo range matches
 * dated documents in it; `undated: true` WIDENS a range to also match undated
 * documents (range OR year IS NULL), and alone matches only them. Full-text and ingest each carry
 * their own `OR`, so they are AND-ed via an explicit `AND` array rather than
 * spread (two `OR` keys at one object level would collide).
 */
export function buildCorpusWhere(
  versionId: string,
  paidOcrEnabled: boolean,
  filters?: CorpusFilterSet,
): CorpusWhere {
  const hasYearRange =
    filters?.yearFrom !== undefined || filters?.yearTo !== undefined
  // `not: null` beside the bounds: the arm is FALSE, never SQL NULL, on an
  // undated row, so `not` stays two-valued.
  const yearRange: Prisma.DocumentWhereInput = {
    year: {
      not: null,
      ...(filters?.yearFrom !== undefined ? { gte: filters.yearFrom } : {}),
      ...(filters?.yearTo !== undefined ? { lte: filters.yearTo } : {}),
    },
  }
  const widenedToUndated = hasYearRange && filters?.undated === true
  const yearWhere: Prisma.DocumentWhereInput = widenedToUndated
    ? {} // an OR — goes in the AND clauses below
    : hasYearRange
      ? yearRange
      : filters?.undated === true
        ? { year: null }
        : {}

  const typeWhere: Prisma.DocumentWhereInput =
    filters?.type && filters.type.length > 0
      ? { docType: { in: filters.type } }
      : {}

  const langWhere: Prisma.DocumentWhereInput =
    filters?.lang && filters.lang.length > 0 ? { lang: { in: filters.lang } } : {}

  const sourceWhere: Prisma.DocumentWhereInput =
    filters?.source && filters.source.length > 0
      ? { source: { in: filters.source } }
      : {}

  // Session filter: keep only documents at least one of the selected sessions
  // contributed. `some` over the CorpusContribution relation gives exactly that.
  const sessionWhere: Prisma.DocumentWhereInput =
    filters?.session && filters.session.length > 0
      ? { contributions: { some: { sessionId: { in: filters.session } } } }
      : {}

  // Full-text: Prisma OR over contains (ILIKE on Postgres, mode-insensitive),
  // matching title, author, and excerpt (null columns are skipped automatically).
  const q = filters?.q
  const fullTextWhere: Prisma.DocumentWhereInput =
    q && q.trim().length > 0
      ? { OR: [documentContains("title", q), documentContains("author", q), documentContains("excerpt", q)] }
      : {}

  // Ingestion-class filter: an OR over the selected classes, each a SQL mirror
  // of classifyIngestion(). Constrained to resolved rows (the class is unknown
  // for stubs). null when no class is selected.
  const ingestPredicates =
    filters?.ingest && filters.ingest.length > 0
      ? filters.ingest
          .map(ingestClassWhere)
          .filter((w): w is Prisma.DocumentWhereInput => w !== null)
      : []
  const ingestWhere: Prisma.DocumentWhereInput | null =
    ingestPredicates.length > 0
      ? { resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED, OR: ingestPredicates }
      : null

  // Indexation-outcome filter: an OR over the selected outcomes, each a SQL
  // mirror of classifyOutcome(). Unlike the ingestion class this is NOT
  // constrained to resolved rows — a stub that no ingest run has covered is
  // legitimately `not_ingested`, and hiding it would under-report exactly the
  // gap this filter exists to show.
  const outcomePredicates =
    filters?.outcome && filters.outcome.length > 0
      ? filters.outcome
          .map((state) => outcomeWhere(state, paidOcrEnabled))
          .filter((w): w is Prisma.DocumentWhereInput => w !== null)
      : []
  const outcomeFilterWhere: Prisma.DocumentWhereInput | null =
    outcomePredicates.length > 0 ? { OR: outcomePredicates } : null

  const andClauses: Prisma.DocumentWhereInput[] = []
  if (widenedToUndated) andClauses.push({ OR: [yearRange, { year: null }] })
  if (filters?.q && filters.q.trim().length > 0) andClauses.push(fullTextWhere)
  if (ingestWhere) andClauses.push(ingestWhere)
  if (outcomeFilterWhere) andClauses.push(outcomeFilterWhere)
  if (filters?.title && filters.title.length > 0) andClauses.push(documentContainsAny("title", filters.title))
  if (filters?.creator && filters.creator.length > 0) {
    andClauses.push(documentContainsAny("author", filters.creator))
  }
  if (filters?.kind && filters.kind.length > 0) andClauses.push({ OR: filters.kind.map(arkKindWhere) })
  // `not` reuses THIS translation for its inside, so an exclusion means
  // exactly what the same filter means positively. The inner predicate carries
  // the membership clause too; under the outer membership clause NOT(member
  // AND inner) reduces to NOT(inner). Decision 4, ONE rule for reads and
  // removals: `not` matches only documents whose every named value is KNOWN
  // (the presence clauses) and that match the inside; a document with an
  // unknown value is neither listed nor removed, and is reported as
  // `notUnknown` (notUnknownWheres).
  if (filters?.not) {
    const inner = buildCorpusWhere(versionId, paidOcrEnabled, filters.not).sharedWhere
    andClauses.push(...corpusNotPresence(filters.not).map((p) => p.known), { NOT: inner })
  }

  const base: Prisma.DocumentWhereInput = {
    membership: { some: { versionId } },
    ...typeWhere,
    ...langWhere,
    ...sourceWhere,
    ...sessionWhere,
    ...yearWhere,
  }

  const sharedWhere: Prisma.DocumentWhereInput = {
    ...base,
    ...(andClauses.length > 0 ? { AND: andClauses } : {}),
  }

  const withoutOutcome = andClauses.filter((c) => c !== outcomeFilterWhere)
  const sharedWhereWithoutOutcome: Prisma.DocumentWhereInput = {
    ...base,
    ...(withoutOutcome.length > 0 ? { AND: withoutOutcome } : {}),
  }

  const resolvedWhere: Prisma.DocumentWhereInput = {
    ...sharedWhere,
    resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
  }

  const membership: Prisma.DocumentWhereInput = { membership: { some: { versionId } } }
  const outcomeOver = (state: IndexationOutcome): Prisma.DocumentWhereInput => {
    const where = outcomeWhere(state, paidOcrEnabled)
    if (where === null) throw new Error(`no predicate for outcome ${state}`)
    return { ...sharedWhereWithoutOutcome, ...where }
  }
  return {
    sharedWhere,
    resolvedWhere,
    sharedWhereWithoutOutcome,
    undatedWhere: {
      ...membership,
      ...typeWhere,
      ...langWhere,
      ...sourceWhere,
      ...fullTextWhere,
      resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
      year: null,
    },
    pendingWhere: { ...membership, ...sourceWhere, resolveStatus: DOCUMENT_RESOLVE_STATUS.PENDING },
    failedWhere: { ...membership, ...sourceWhere, resolveStatus: DOCUMENT_RESOLVE_STATUS.FAILED },
    outcomeWheres: {
      [INDEXATION_OUTCOME.INDEXED]: outcomeOver(INDEXATION_OUTCOME.INDEXED),
      [INDEXATION_OUTCOME.FAILED]: outcomeOver(INDEXATION_OUTCOME.FAILED),
      [INDEXATION_OUTCOME.EXCLUDED]: outcomeOver(INDEXATION_OUTCOME.EXCLUDED),
      [INDEXATION_OUTCOME.NOT_INGESTED]: outcomeOver(INDEXATION_OUTCOME.NOT_INGESTED),
    },
  }
}


/**
 * Every predicate a corpus read needs, built once from the filters:
 *   - `sharedWhere`   — version membership AND every active filter clause.
 *   - `resolvedWhere` — `sharedWhere` further constrained to RESOLVED
 *                       documents (the type/lang/period facets, the histogram,
 *                       the numérisation card: meaningless for stubs).
 *   - `sharedWhereWithoutOutcome` — `sharedWhere` without the outcome clause,
 *                       so the per-outcome counts stay informative while an
 *                       outcome filter is active.
 *   - `undatedWhere`  — RESOLVED documents with no year, the year range
 *                       deliberately not applied ("Période non datée" stays
 *                       informative under a range).
 *   - `pendingWhere` / `failedWhere` — stubs, honouring only `source`
 *                       (ARK-derived, known for a stub).
 *   - `outcomeWheres` — the four indexation outcomes over
 *                       sharedWhereWithoutOutcome: mutually exclusive and
 *                       total, so they sum to the unfiltered-by-outcome count.
 */
export type CorpusWhere = CorpusWherePredicates

/**
 * For a filter set with `not`: per dimension the exclusion names, the
 * predicate of the documents matching the POSITIVE filters whose value is
 * unknown — the documents `not` left out. Empty when there is no `not`.
 */
export function notUnknownWheres(
  versionId: string,
  paidOcrEnabled: boolean,
  filters: CorpusFilterSet | undefined,
): Array<{ dimension: string; where: Prisma.DocumentWhereInput }> {
  if (filters?.not === undefined) return []
  const { not, ...positive } = filters
  const { sharedWhere } = buildCorpusWhere(versionId, paidOcrEnabled, positive)
  return corpusNotPresence(not).map((p) => ({ dimension: p.dimension, where: { AND: [sharedWhere, p.unknown] } }))
}

/**
 * The numérisation buckets of a set of resolved documents (classifyIngestion
 * over each) — the snapshot's "Numérisation" card.
 */
export function numerisationOf(
  rows: ReadonlyArray<{ docType: string | null; ocrAvailable: boolean | null; iiifManifestUrl: string | null }>,
): CorpusSnapshot["numerisation"] {
  const n = { resolved: rows.length, digitized: 0, ingestable: 0, ocr: 0, vision: 0, sansTexte: 0, nonNumerise: 0 }
  for (const r of rows) {
    switch (classifyIngestion({ docType: r.docType, ocrAvailable: r.ocrAvailable, digitized: Boolean(r.iiifManifestUrl) })) {
      case INGESTION_CLASS.OCR:
        n.ocr++
        break
      case INGESTION_CLASS.VISION:
        n.vision++
        break
      case INGESTION_CLASS.SANS_TEXTE:
        n.sansTexte++
        break
      case INGESTION_CLASS.NON_NUMERISE:
        n.nonNumerise++
        break
    }
  }
  n.digitized = n.ocr + n.vision + n.sansTexte
  n.ingestable = n.ocr + n.vision
  return n
}
