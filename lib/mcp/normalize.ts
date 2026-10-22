// lib/mcp/normalize.ts
// Pure functional layer mapping BnF MCP outputs → our Document row shape.
//
// Consumers:
//   - scripts/seed-from-mcp.ts            (slice 2 — real-data seeding)
//   - models/documents/service.ts         (DocumentService.upsertMany)
//   - lib/agent/dispatch.ts               (slice 3 — corpus.add tool handler)
//
// This module is intentionally side-effect-free: no Prisma import, no logging
// I/O. Callers receive structured diagnostics (unknownDocTypeHook) and decide
// what to do with them.
//
// See: playbook/mcp-client.md
//      ai-memories/…/persistence-architecture/research/bnf-mcp-contract.md
//      ai-memories/…/mcp-and-filters/plan/implementation-plan.md §4

import { PAGES_SOURCE, type BnfMcpDocumentDetail } from "@/lib/bnf/types"
import {
  GALLICA_DOC_TYPE,
  canonicalLang,
  gallicaPageCount,
  gallicaSubtype,
  iiifManifestUrl,
  mapCatalogueDocType,
  mapGallicaTypedoc,
  sourceFromArk,
} from "@/lib/mcp/vocab"
import { fullBnfArk } from "@/lib/validation/ark"
import { DOC_TYPE_CODE, DOCUMENT_SOURCE } from "@/models/documents/schema"

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

/**
 * Normalized document row ready to feed into DocumentService.upsertMany.
 *
 * Does NOT import from the Prisma client — this type is standalone so the file
 * compiles regardless of whether the Document schema has migrated (e.g. before
 * the parallel commit that adds the `dateLabel` column lands).
 *
 * `dateLabel` is optional for the same reason: it maps to a column that may
 * not yet exist in the database when this commit is first deployed alone.
 */
export interface NormalizedDocument {
  ark: string // full canonical form: ark:/12148/…
  title: string
  author?: string | null
  year?: number | null
  dateLabel?: string | null
  docType: string
  /**
   * Gallica typedoc subcategory token ("fascicules", "titres", "plan", …) — a
   * finer facet than docType for RAG/UI filtering. Null for non-Gallica docs or
   * when the typedoc has no subcategory. See gallicaSubtype.
   */
  subtype?: string | null
  lang?: string | null
  source: string
  pages?: number | null
  excerpt?: string | null
  iiifManifestUrl?: string | null
  /** OCR text-layer availability as reported by the MCP; null when unknown. */
  ocrAvailable?: boolean | null
  rawMetadata: unknown // full MCP payload preserved for re-normalize without re-fetch
}

/**
 * Why normalizeDocument refused a record. A refusal is a resolve failure, never
 * an empty row: callers learn the reason through `onRejected`.
 */
export const NORMALIZE_REJECTION = {
  /** `ark` missing or not a string. */
  NO_ARK: "no_ark",
  /** A `temp-work/` URI: not a stable document key. */
  TEMP_WORK: "temp_work",
  /** Neither `title` nor `creator` is usable. */
  NO_TITLE: "no_title",
  /** A bare local id that does not form a valid ARK once given the BnF naan. */
  BAD_ARK: "bad_ark",
} as const
export type NormalizeRejection =
  (typeof NORMALIZE_REJECTION)[keyof typeof NORMALIZE_REJECTION]

export interface NormalizeOptions {
  unknownDocTypeHook?: (raw: string, source: string) => void
  /** Called once per refused record; `ark` is null when the record has none. */
  onRejected?: (ark: string | null, reason: NormalizeRejection) => void
}

// ---------------------------------------------------------------------------
// Roman-numeral helper (handles I–XXI, enough for BnF century strings)
// ---------------------------------------------------------------------------

/** Roman-numeral digit values. */
const ROMAN: Record<string, number> = {
  I: 1,
  V: 5,
  X: 10,
  L: 50,
  C: 100,
  D: 500,
  M: 1000,
}

/**
 * Parse a Roman-numeral string into an integer.
 * Returns NaN when the input contains non-Roman characters.
 *
 * Uses the standard subtractive rule: when a smaller value precedes a larger
 * one the smaller is subtracted (e.g. IV = 4, IX = 9).
 */
function parseRoman(s: string): number {
  const upper = s.toUpperCase()
  let result = 0
  let prev = 0
  for (let i = upper.length - 1; i >= 0; i--) {
    const val = ROMAN[upper[i]]
    if (val === undefined) return NaN
    if (val < prev) {
      result -= val
    } else {
      result += val
      prev = val
    }
  }
  return result
}

/**
 * Normalize a Roman-numeral century string to our canonical display form.
 *
 * Examples:
 *   "XIX siècle"    → "XIXe siècle"
 *   "XIXe siècle"   → "XIXe siècle"   (already correct)
 *   "XIXème siècle" → "XIXe siècle"   (normalize suffix)
 *
 * Returns null when `roman` is not a parseable Roman numeral.
 */
function normalizeCenturyLabel(roman: string): string | null {
  const n = parseRoman(roman)
  if (isNaN(n) || n <= 0) return null
  return `${roman.toUpperCase()}e siècle`
}

// ---------------------------------------------------------------------------
// parseBnfDate
// ---------------------------------------------------------------------------

/**
 * Parse a free-text BnF date string into a numeric year and a display label.
 *
 * Rules (per ai-memories/…/implementation-plan.md §4):
 *
 * | Input pattern                              | year        | label                      |
 * |--------------------------------------------|-------------|----------------------------|
 * | null / ""                                  | null        | null                       |
 * | "1862"  (exactly 4 digits)                 | 1862        | null                       |
 * | "1937-07-12" / "1937-07" (ISO date)        | 1937        | "1937-07-12" (verbatim)    |
 * | "vers 1890" / "circa 1890" / "ca 1890"     | 1890        | "vers 1890" (normalised)   |
 * | "1850–1860" / "1850-1860" / "1850/1860"    | 1850        | "1850–1860" (en-dash)      |
 * | "XIXe siècle" / "XIXème siècle"            | null        | "XIXe siècle"              |
 * | Anything else unparseable                  | null        | raw input preserved        |
 */
export function parseBnfDate(
  raw: string | null | undefined,
): { year: number | null; label: string | null } {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return { year: null, label: null }
  }

  const s = raw.trim()

  // 1. Exact 4-digit year —————————————————————————————————————————————————
  if (/^\d{4}$/.test(s)) {
    return { year: parseInt(s, 10), label: null }
  }

  // 1b. Full ISO date "YYYY-MM-DD" or "YYYY-MM" — how Gallica dates a press
  //     ISSUE. Without this rule an issue fell to "unparseable" (year null)
  //     and vanished from year filters and the period histogram. The label
  //     keeps the full date: it is what tells two issues of a title apart.
  const isoMatch = /^(\d{4})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.exec(s)
  if (isoMatch) {
    return { year: parseInt(isoMatch[1], 10), label: s }
  }

  // 2. Approximate year: "vers 1890" / "circa 1890" / "ca. 1890" / "ca 1890"
  //    (case-insensitive). Capture the year; label is normalised to "vers N".
  const approxMatch = /^(?:vers|circa|ca\.?)\s+(\d{4})\b/i.exec(s)
  if (approxMatch) {
    const year = parseInt(approxMatch[1], 10)
    return { year, label: `vers ${approxMatch[1]}` }
  }

  // 3. Year range: "1850–1860" / "1850-1860" / "1850/1860"
  //    First year is stored as `year`; label uses the en-dash form.
  const rangeMatch = /^(\d{4})\s*[–\-/]\s*(\d{4})$/.exec(s)
  if (rangeMatch) {
    const from = parseInt(rangeMatch[1], 10)
    const to = parseInt(rangeMatch[2], 10)
    return { year: from, label: `${from}–${to}` }
  }

  // 4. Century strings: "XIXe siècle" / "XIXème siècle" / "XIX siècle"
  //    (case-insensitive Roman numeral + optional suffix + "siècle").
  //    year = null; label is normalized to "XIXe siècle".
  const centuryMatch =
    /^([IVXLCDM]+)(?:e|ème|eme|er)?\s+si[eè]cle$/i.exec(s)
  if (centuryMatch) {
    const label = normalizeCenturyLabel(centuryMatch[1])
    if (label !== null) {
      return { year: null, label }
    }
  }

  // 5. Anything else — preserve raw string; year unknown.
  return { year: null, label: s }
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

// ---------------------------------------------------------------------------
// normalizeDocument
// ---------------------------------------------------------------------------

/**
 * Normalize a single MCP document detail record into our NormalizedDocument
 * shape.
 *
 * Algorithm (per plan §4):
 *
 * 1. Resolve full ARK (the BnF naan is restored on a parser's bare local id;
 *    an id that then is no valid ARK is refused as `bad_ark`).
 * 2. Derive `source` from the ARK prefix.
 * 3. `title` — fall back to `creator` when absent. If still absent, return
 *    null (reported through `opts.onRejected` as `no_title`).
 * 4. `author` — prefer `author`, fall back to `creator`.
 * 5. `parseBnfDate(mcp.date)` → `{ year, label: dateLabel }`.
 * 6. `lang` — canonicalLang: MARC 639-2 (both columns) → ISO 639-1, language
 *    names → code; unknown codes preserved lowercased.
 * 7. `docType` — Gallica enum key → GALLICA_DOC_TYPE[key]; Catalogue
 *    free-text → mapCatalogueDocType(); missing → "book" for catalogue,
 *    "other" for anything else; unknown free-text → "other" + hook.
 * 8. `pages` — Gallica: the manifest canvas count when `pages_source` is
 *    "manifest", else gallicaPageCount over OAI's raw view count (null for
 *    periodical issues); Catalogue: passed through. `excerpt` — as-is.
 * 9. `iiifManifestUrl` — derived via vocab helper (Gallica only).
 * 10. `rawMetadata` — the full mcp object (preserve for re-normalize).
 *
 * Returns null when the ARK is missing or invalid, is a temp-work/ URI, or when
 * both `title` and `creator` are absent; `opts.onRejected` receives the reason.
 * The resolver treats a null as a resolve failure.
 */
export function normalizeDocument(
  mcp: BnfMcpDocumentDetail,
  opts?: NormalizeOptions,
): NormalizedDocument | null {
  // ── 1. ARK ────────────────────────────────────────────────────────────────
  const rawArk = mcp.ark
  if (typeof rawArk !== "string" || rawArk.trim() === "") {
    opts?.onRejected?.(null, NORMALIZE_REJECTION.NO_ARK)
    return null
  }
  const fullArk = fullBnfArk(rawArk)
  if (fullArk === null) {
    opts?.onRejected?.(rawArk, NORMALIZE_REJECTION.BAD_ARK)
    return null
  }

  // ── 2. Source ─────────────────────────────────────────────────────────────
  const source = sourceFromArk(fullArk)

  // temp-work/ URIs are unusable as stable document keys.
  if (source === DOCUMENT_SOURCE.DATABNF) {
    opts?.onRejected?.(fullArk, NORMALIZE_REJECTION.TEMP_WORK)
    return null
  }

  // ── 3. Title fallback ─────────────────────────────────────────────────────
  const title =
    typeof mcp.title === "string" && mcp.title.trim() !== ""
      ? mcp.title.trim()
      : typeof mcp.creator === "string" && mcp.creator.trim() !== ""
        ? mcp.creator.trim()
        : null

  if (title === null) {
    opts?.onRejected?.(fullArk, NORMALIZE_REJECTION.NO_TITLE)
    return null
  }

  // ── 4. Author ─────────────────────────────────────────────────────────────
  const author =
    (typeof mcp.author === "string" && mcp.author.trim() !== ""
      ? mcp.author.trim()
      : undefined) ??
    (typeof mcp.creator === "string" && mcp.creator.trim() !== ""
      ? mcp.creator.trim()
      : undefined) ??
    null

  // ── 5. Date → year + dateLabel ────────────────────────────────────────────
  const rawDate =
    typeof mcp.date === "string" && mcp.date.trim() !== ""
      ? mcp.date.trim()
      : null
  const { year, label: dateLabel } = parseBnfDate(rawDate)

  // ── 6. Language ───────────────────────────────────────────────────────────
  // canonicalLang knows both ISO 639-2 columns: MARC records carry the
  // bibliographic codes (`ger`, `dut`), which the old terminology-only lookup
  // left verbatim — so German documents were `ger`, matched by no `de` filter.
  const lang = canonicalLang(typeof mcp.language === "string" ? mcp.language : null)

  // ── 7. docType + subtype ──────────────────────────────────────────────────
  // The Gallica typedoc set (OAI-PMH record header) is the AUTHORITATIVE
  // discriminator and takes precedence: the <dc:type> physical-form labels
  // ("texte", "publication en série imprimée") collapse periodicals and
  // monographs alike to "book". See mapGallicaTypedoc / gallicaSubtype + the
  // direct.ts pickTypedoc that extracts it. The typedoc tail also yields the
  // finer `subtype` facet (fascicules / titres / plan / …).
  const rawTypedoc =
    typeof mcp.gallica_typedoc === "string" && mcp.gallica_typedoc.trim() !== ""
      ? mcp.gallica_typedoc.trim()
      : null
  const typedocType = mapGallicaTypedoc(rawTypedoc)
  const subtype = gallicaSubtype(rawTypedoc)

  const rawDocType =
    typeof mcp.doc_type === "string" && mcp.doc_type.trim() !== ""
      ? mcp.doc_type.trim()
      : null

  let docType: string

  if (typedocType !== null) {
    // Authoritative Gallica typedoc.
    docType = typedocType
  } else if (rawDocType !== null) {
    if (rawDocType in GALLICA_DOC_TYPE) {
      // Gallica enum value
      docType = GALLICA_DOC_TYPE[rawDocType]
    } else {
      // Catalogue free-text → best-effort regex mapping
      const mapped = mapCatalogueDocType(rawDocType)
      if (mapped !== null) {
        docType = mapped
      } else {
        docType = DOC_TYPE_CODE.OTHER
        opts?.unknownDocTypeHook?.(rawDocType, source)
      }
    }
  } else {
    // No typedoc and no doc_type field at all:
    //   Catalogue records are predominantly books → "book"
    //   Everything else → "other"
    docType = source === DOCUMENT_SOURCE.CATALOGUE ? DOC_TYPE_CODE.BOOK : DOC_TYPE_CODE.OTHER
  }

  // ── 8. Pages + excerpt ────────────────────────────────────────────────────
  // The ONE place that decides `pages` for a Gallica record, so the resolver,
  // the BnfRecord cache read, the enricher and fix-doc-types agree:
  //   - the IIIF manifest was fetched (`pages_source === "manifest"`): its
  //     canvas count is authoritative whatever the type, a fascicule included;
  //   - otherwise OAI's raw view count goes through gallicaPageCount, which
  //     refuses it for periodical issues (collection-level figure) and for
  //     anything that is not a positive integer.
  // Catalogue records keep the count the SRU parser gave.
  const pages =
    source === DOCUMENT_SOURCE.GALLICA
      ? mcp.pages_source === PAGES_SOURCE.MANIFEST
        ? finiteNumberOrNull(mcp.pages)
        : gallicaPageCount(
            rawTypedoc ?? undefined,
            mcp.oai_total_views,
            rawDocType ?? undefined,
          )
      : finiteNumberOrNull(mcp.pages)
  const excerpt =
    typeof mcp.excerpt === "string" && mcp.excerpt.trim() !== ""
      ? mcp.excerpt.trim()
      : null

  // ── 9. IIIF manifest URL ──────────────────────────────────────────────────
  const manifestUrl = iiifManifestUrl(fullArk, source)

  // ── 9b. OCR availability ──────────────────────────────────────────────────
  // Preserve true/false as the resolver set it; leave null (unknown) when the
  // field is absent or null rather than guessing. Never coerced to false: false
  // routes a document to paid OCR.
  const ocrAvailable =
    typeof mcp.ocr_available === "boolean" ? mcp.ocr_available : null

  // ── 10. rawMetadata ───────────────────────────────────────────────────────
  // Preserve the full payload so we can re-normalize without re-fetching. It
  // keeps the provenance the page and OCR decisions depended on
  // (`oai_total_views`, `ocr_source`, `pages_source`).
  const rawMetadata: unknown = mcp

  return {
    ark: fullArk,
    title,
    author,
    year,
    dateLabel,
    docType,
    subtype,
    lang,
    source,
    pages,
    excerpt,
    iiifManifestUrl: manifestUrl,
    ocrAvailable,
    rawMetadata,
  }
}

// ---------------------------------------------------------------------------
// normalizeMany
// ---------------------------------------------------------------------------

/**
 * Normalize a batch of MCP document detail records. A record normalizeDocument
 * refuses is absent from the result and reported through `opts.onRejected`
 * (reasons: NORMALIZE_REJECTION), so a caller can mark that ARK failed.
 */
export function normalizeMany(
  mcps: BnfMcpDocumentDetail[],
  opts?: NormalizeOptions,
): NormalizedDocument[] {
  const results: NormalizedDocument[] = []
  for (const mcp of mcps) {
    const doc = normalizeDocument(mcp, opts)
    if (doc !== null) {
      results.push(doc)
    }
  }
  return results
}
