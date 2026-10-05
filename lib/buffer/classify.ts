// lib/buffer/classify.ts
// The buffer's classification rules, in ONE place: what canonical docType,
// language and record kind a buffer row carries, and how a bare row takes its
// metadata from a resolved Document. Used by the staging tools
// (lib/agent/tools/buffer.ts), the boot-time reclassifier
// (lib/buffer/reclassify.ts) and the enrichment drain (lib/buffer/enricher.ts),
// so a row means the same thing whichever path wrote it.
//
// Pure: no I/O, no server-only, so every rule is unit-testable.
import {
  GALLICA_FILTER_DOC_TYPE,
  GALLICA_SEARCHABLE_DOC_TYPE,
  canonicalDocTypeFromLabel,
  canonicalLang,
  mapGallicaTypedoc,
} from "@/lib/mcp/vocab"
import { AGENT_TOOLS } from "@/lib/agent/tools/constants"
import { classifyArkKind, type ArkKind } from "@/lib/documents/ark-kind"
import { DOCUMENT_SOURCE } from "@/models/documents/schema"

export type GallicaSearchDocType = (typeof GALLICA_SEARCHABLE_DOC_TYPE)[number]

const SEARCHABLE = new Set<string>(GALLICA_SEARCHABLE_DOC_TYPE)

function isSearchableDocType(value: string): value is GallicaSearchDocType {
  return SEARCHABLE.has(value)
}

/** Every `dc.type` clause of a CQL (search_gallica.py writes `dc.type all
 *  "<v>"`; `any`/`adj` appear in hand-written CQL), with what precedes it. */
const DC_TYPE_CLAUSES = /(\bnot\s+)?\bdc\.type\s+(?:all|any|adj)\s+"([^"]+)"/gi
/** A boolean `or` anywhere in the query. */
const CQL_OR = /\bor\b/i

/**
 * The Gallica `doc_type` filter a search was run with, recovered from its CQL,
 * or null when it cannot be read with certainty. This is how a row staged
 * before the v2 buffer recovers the search's type — 0.18.1 stored the executed
 * CQL in `originQuery` — and how a raw-CQL search is classified like a
 * structured one.
 *
 * Only an unambiguous query counts: exactly one `dc.type` clause, not negated,
 * and no `or` in the query. `not dc.type all "fascicule"` says what the hits
 * are NOT; `dc.type all "a" or …` does not hold for every hit. Those are
 * ambiguous, so the type is left to each hit's own label (stored as fact by
 * the reclassifier and the search path, a guess here would be false data).
 */
export function searchDocTypeFromCql(cql: string | null | undefined): GallicaSearchDocType | null {
  if (typeof cql !== "string") return null
  const clauses = [...cql.matchAll(DC_TYPE_CLAUSES)]
  if (clauses.length !== 1 || CQL_OR.test(cql)) return null
  const [clause] = clauses
  if (clause[1] !== undefined) return null
  const value = clause[2].trim().toLowerCase()
  return isSearchableDocType(value) ? value : null
}

/**
 * The Gallica `doc_type` filter a search ran with: the structured filter when
 * it is a searchable value, else the `dc.type` clause of its CQL (a raw-CQL
 * search, or the executed CQL mcp-bnf echoes back). Null when it had none.
 */
export function gallicaSearchDocType(
  filter: string | null | undefined,
  cql: string | null | undefined,
): GallicaSearchDocType | null {
  const folded = typeof filter === "string" ? filter.trim().toLowerCase() : ""
  if (isSearchableDocType(folded)) return folded
  return searchDocTypeFromCql(cql)
}

/**
 * The canonical docType of a hit. Precedence (Decision 2 of the Track E plan):
 * the search's own `doc_type` filter, when one was used — it says more about
 * every hit than the hit's label, because Gallica labels press issues and
 * monographs alike `text` — otherwise the folded dc:type label. `known: false`
 * flags a label no rule recognised (it maps to `other`; the caller logs it).
 */
export function canonicalBufferDocType(
  rawLabel: string | null | undefined,
  searchDocType: GallicaSearchDocType | null,
): { code: string | null; known: boolean } {
  if (searchDocType !== null) return { code: GALLICA_FILTER_DOC_TYPE[searchDocType], known: true }
  return canonicalDocTypeFromLabel(rawLabel)
}

/** A buffer row as the 0.18.1 code wrote it: docType holds the RAW label. */
export type LegacyBufferRow = {
  ark: string
  docType: string | null
  lang: string | null
  originTool: string
  originQuery: string | null
  source: string | null
}

/** The v1 classification columns of a reclassified legacy row. */
export type BufferClassification = {
  docTypeRaw: string | null
  docType: string | null
  lang: string | null
  arkKind: ArkKind
  /** The raw label when no rule recognised it, for the caller's log. */
  unknownLabel: string | null
}

/** The search tool whose `originQuery` is an executed CQL (others hold ARKs or nothing). */
const SEARCH_ORIGIN_TOOL = AGENT_TOOLS.corpusSearch
const SEARCH_SOURCES = new Set<string>([DOCUMENT_SOURCE.GALLICA, DOCUMENT_SOURCE.CATALOGUE])

/**
 * Classification version 0 → 1 for one legacy row. The raw label moves to
 * docTypeRaw; docType becomes canonical (the search's doc_type, recovered from
 * the stored CQL, first); lang becomes canonical; arkKind is derived.
 *
 * `collectionEntry` is unrecoverable for old rows (toFullArk stripped the
 * `/date` before 0.18.1 stored the ARK), but rule 2 of classifyArkKind still
 * classifies a `cb` + `press` row as a periodical collection.
 */
export function classifyLegacyRow(row: LegacyBufferRow): BufferClassification {
  const searchDocType =
    row.originTool === SEARCH_ORIGIN_TOOL && row.source !== null && SEARCH_SOURCES.has(row.source)
      ? searchDocTypeFromCql(row.originQuery)
      : null
  const docType = canonicalBufferDocType(row.docType, searchDocType)
  return {
    docTypeRaw: row.docType,
    docType: docType.code,
    lang: canonicalLang(row.lang),
    arkKind: classifyArkKind({ ark: row.ark, collectionEntry: false, docType: docType.code }),
    unknownLabel: docType.known ? null : row.docType,
  }
}

/** The fields of a resolved Document a bare buffer row can take. */
export type ResolvedDocumentFields = {
  ark: string
  title: string | null
  author: string | null
  year: number | null
  dateLabel: string | null
  docType: string | null
  lang: string | null
  rawMetadata: unknown
}

/** The buffer columns a resolved record fills on a bare row. */
export type BufferMetadataFromDocument = {
  title: string | null
  creator: string | null
  year: number | null
  /** Last year of a range label ("1861-1946"); null for a single date. */
  yearEnd: number | null
  dateLabel: string | null
  /** Canonical, through the same rules as a search hit (bufferDocTypeFromRecord). */
  docType: string | null
  /** The record's own type label, verbatim. */
  docTypeRaw: string | null
  lang: string | null
  publisher: string | null
  subjects: string | null
  gallicaUrl: string | null
  catalogueUrl: string | null
  arkKind: ArkKind
}

/** Rameau headings use `--` internally, never `;`, so " ; " is a safe joiner. */
export const BUFFER_SUBJECTS_SEPARATOR = " ; "

/** A non-empty trimmed string field of an untyped payload (a resolved
 *  record's preserved raw metadata), or null. */
export function stringField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null || !(key in payload)) return null
  const value: unknown = Reflect.get(payload, key)
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

/** A string-array field of an untyped payload, joined, or null. */
function joinedListField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null || !(key in payload)) return null
  const value: unknown = Reflect.get(payload, key)
  if (!Array.isArray(value)) return null
  const items = value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim())
  return items.length > 0 ? items.join(BUFFER_SUBJECTS_SEPARATOR) : null
}

/** The last year of a range label ("1861-1946" → 1946), when it is after `year`. */
export function yearEndFromLabel(label: string | null | undefined, year: number | null | undefined): number | null {
  const m = /(\d{4})\D+(\d{4})/.exec(label ?? "")
  if (m === null || year === null || year === undefined) return null
  const end = Number(m[2])
  return end > year ? end : null
}

/** Called with a type label no rule recognised (the caller logs it). */
export type UnknownDocTypeHook = (rawLabel: string) => void

/**
 * The canonical docType of a resolved record, by the rules a search hit gets
 * (Decision 2): the Gallica typedoc when the record has one (the OAI record's
 * press discriminator), else the folded dc:type label through
 * canonicalBufferDocType — an unrecognised label maps to `other` and is
 * reported to `onUnknown` — else null. Never a guessed `book`: a record with
 * no type is unknown, the same ARK classifies the same whichever path wrote it.
 */
export function bufferDocTypeFromRecord(rawMetadata: unknown, onUnknown: UnknownDocTypeHook): string | null {
  const typedoc = mapGallicaTypedoc(stringField(rawMetadata, "gallica_typedoc"))
  if (typedoc !== null) return typedoc
  const label = stringField(rawMetadata, "doc_type")
  if (label === null) return null
  const canonical = canonicalBufferDocType(label, null)
  if (!canonical.known) onUnknown(label)
  return canonical.code
}

/**
 * Metadata for a bare buffer row from a resolved record of the same ARK — the
 * project's resolved Document (zero BnF cost) or the broker's record. The type
 * goes through bufferDocTypeFromRecord; the publisher, subjects, raw label and
 * links come from the preserved raw payload.
 */
export function bufferMetadataFromDocument(
  doc: ResolvedDocumentFields,
  onUnknown: UnknownDocTypeHook,
): BufferMetadataFromDocument {
  // No preserved payload at all (a Document written by a path that kept
  // none): its docType is already canonical — the payload is what would let us
  // do better, not a reason to drop the type.
  const docType = doc.rawMetadata === null ? doc.docType : bufferDocTypeFromRecord(doc.rawMetadata, onUnknown)
  return {
    title: doc.title,
    creator: doc.author,
    year: doc.year,
    yearEnd: yearEndFromLabel(doc.dateLabel, doc.year),
    dateLabel: doc.dateLabel,
    docType,
    docTypeRaw: stringField(doc.rawMetadata, "doc_type"),
    lang: canonicalLang(doc.lang),
    publisher: stringField(doc.rawMetadata, "publisher"),
    subjects: joinedListField(doc.rawMetadata, "subject"),
    gallicaUrl: stringField(doc.rawMetadata, "gallica_url"),
    catalogueUrl: stringField(doc.rawMetadata, "catalogue_url"),
    arkKind: classifyArkKind({ ark: doc.ark, collectionEntry: false, docType }),
  }
}
