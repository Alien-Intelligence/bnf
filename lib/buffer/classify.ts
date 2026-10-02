// lib/buffer/classify.ts
// The buffer's classification rules, in ONE place: what canonical docType,
// language and record kind a buffer row carries, and how a bare row takes its
// metadata from a resolved Document. Used by the staging tools
// (lib/agent/tools/buffer.ts), the boot-time reclassifier
// (lib/buffer/reclassify.ts) and the enrichment drain (lib/buffer/enricher.ts),
// so a row means the same thing whichever path wrote it.
//
// Pure: no I/O, no server-only, so every rule is unit-testable.
import { GALLICA_FILTER_DOC_TYPE, GALLICA_SEARCHABLE_DOC_TYPE, canonicalDocTypeFromLabel, canonicalLang } from "@/lib/mcp/vocab"
import { classifyArkKind, type ArkKind } from "@/models/documents/schema"

export type GallicaSearchDocType = (typeof GALLICA_SEARCHABLE_DOC_TYPE)[number]

const SEARCHABLE = new Set<string>(GALLICA_SEARCHABLE_DOC_TYPE)

function isSearchableDocType(value: string): value is GallicaSearchDocType {
  return SEARCHABLE.has(value)
}

/** The `dc.type` clause mcp-bnf writes for a Gallica `doc_type` filter
 *  (search_gallica.py: `dc.type all "<v>"`); `any`/`adj` for hand-written CQL. */
const DC_TYPE_CLAUSE = /\bdc\.type\s+(?:all|any|adj)\s+"([^"]+)"/i

/**
 * The Gallica `doc_type` filter a search was run with, recovered from its CQL,
 * or null when the CQL carries no (searchable) `dc.type` clause. This is how a
 * row staged before the v2 buffer recovers the search's type — 0.18.1 stored
 * the executed CQL in `originQuery` — and how a raw-CQL search is classified
 * like a structured one.
 */
export function searchDocTypeFromCql(cql: string | null | undefined): GallicaSearchDocType | null {
  if (typeof cql !== "string") return null
  const match = DC_TYPE_CLAUSE.exec(cql)
  if (match === null) return null
  const value = match[1].trim().toLowerCase()
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
const SEARCH_ORIGIN_TOOL = "corpus_search"
const SEARCH_SOURCES = new Set(["gallica", "catalogue"])

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

/** The buffer columns a resolved Document fills on a bare row. */
export type BufferMetadataFromDocument = {
  title: string | null
  creator: string | null
  year: number | null
  dateLabel: string | null
  docType: string | null
  lang: string | null
  publisher: string | null
  subjects: string | null
  arkKind: ArkKind
}

/** Rameau headings use `--` internally, never `;`, so " ; " is a safe joiner. */
export const BUFFER_SUBJECTS_SEPARATOR = " ; "

/** A non-empty trimmed string field of an untyped payload, or null. */
function stringField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

/** A string-array field of an untyped payload, joined, or null. */
function joinedListField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  if (!Array.isArray(value)) return null
  const items = value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim())
  return items.length > 0 ? items.join(BUFFER_SUBJECTS_SEPARATOR) : null
}

/**
 * Metadata for a bare buffer row from the project's resolved Document of the
 * same ARK — zero BnF cost. Document already holds the normalised vocabulary
 * (normalizeMany), so docType is canonical; the publisher and subjects come
 * from the preserved raw payload (BnfMcpDocumentDetail.publisher / .subject).
 */
export function bufferMetadataFromDocument(doc: ResolvedDocumentFields): BufferMetadataFromDocument {
  return {
    title: doc.title,
    creator: doc.author,
    year: doc.year,
    dateLabel: doc.dateLabel,
    docType: doc.docType,
    lang: canonicalLang(doc.lang),
    publisher: stringField(doc.rawMetadata, "publisher"),
    subjects: joinedListField(doc.rawMetadata, "subject"),
    arkKind: classifyArkKind({ ark: doc.ark, collectionEntry: false, docType: doc.docType }),
  }
}
