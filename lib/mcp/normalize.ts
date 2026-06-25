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

import type { BnfMcpDocumentDetail } from "@/lib/bnf/types"
import {
  GALLICA_DOC_TYPE,
  MARC_TO_ISO_LANG,
  gallicaSubtype,
  iiifManifestUrl,
  mapCatalogueDocType,
  mapGallicaTypedoc,
  sourceFromArk,
} from "@/lib/mcp/vocab"

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

// ---------------------------------------------------------------------------
// normalizeDocument
// ---------------------------------------------------------------------------

/**
 * Normalize a single MCP document detail record into our NormalizedDocument
 * shape.
 *
 * Algorithm (per plan §4):
 *
 * 1. Resolve full ARK (`ark:/12148/<id>` if short form is supplied).
 * 2. Derive `source` from the ARK prefix.
 * 3. `title` — fall back to `creator` when absent. If still absent, return
 *    null (caller — normalizeMany — drops the record).
 * 4. `author` — prefer `author`, fall back to `creator`.
 * 5. `parseBnfDate(mcp.date)` → `{ year, label: dateLabel }`.
 * 6. `lang` — map MARC 639-2 via MARC_TO_ISO_LANG; preserve unknown codes
 *    verbatim.
 * 7. `docType` — Gallica enum key → GALLICA_DOC_TYPE[key]; Catalogue
 *    free-text → mapCatalogueDocType(); missing → "book" for catalogue,
 *    "other" for anything else; unknown free-text → "other" + hook.
 * 8. `pages` / `excerpt` — passed through as-is when present.
 * 9. `iiifManifestUrl` — derived via vocab helper (Gallica only).
 * 10. `rawMetadata` — the full mcp object (preserve for re-normalize).
 *
 * Returns null when the ARK is missing, is a temp-work/ URI, or when both
 * `title` and `creator` are absent. `normalizeMany` uses these sentinel nulls
 * to filter records.
 */
export function normalizeDocument(
  mcp: BnfMcpDocumentDetail,
  opts?: { unknownDocTypeHook?: (raw: string, source: string) => void },
): NormalizedDocument | null {
  // ── 1. Full ARK ──────────────────────────────────────────────────────────
  const rawArk = mcp.ark
  if (!rawArk || typeof rawArk !== "string" || rawArk.trim() === "") {
    return null
  }
  const fullArk = rawArk.startsWith("ark:/")
    ? rawArk
    : `ark:/12148/${rawArk}`

  // ── 2. Source ─────────────────────────────────────────────────────────────
  const source = sourceFromArk(fullArk)

  // temp-work/ URIs are unusable as stable document keys.
  if (source === "databnf") return null

  // ── 3. Title fallback ─────────────────────────────────────────────────────
  const title =
    typeof mcp.title === "string" && mcp.title.trim() !== ""
      ? mcp.title.trim()
      : typeof mcp.creator === "string" && mcp.creator.trim() !== ""
        ? mcp.creator.trim()
        : null

  if (title === null) return null

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
  const rawLang =
    typeof mcp.language === "string" && mcp.language.trim() !== ""
      ? mcp.language.trim()
      : null
  const lang =
    rawLang !== null
      ? (MARC_TO_ISO_LANG[rawLang] ?? rawLang) // preserve unknown codes verbatim
      : null

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
        docType = "other"
        opts?.unknownDocTypeHook?.(rawDocType, source)
      }
    }
  } else {
    // No typedoc and no doc_type field at all:
    //   Catalogue records are predominantly books → "book"
    //   Everything else → "other"
    docType = source === "catalogue" ? "book" : "other"
  }

  // ── 8. Pages + excerpt ────────────────────────────────────────────────────
  const pages =
    typeof mcp.pages === "number" && Number.isFinite(mcp.pages)
      ? mcp.pages
      : null
  const excerpt =
    typeof mcp.excerpt === "string" && mcp.excerpt.trim() !== ""
      ? mcp.excerpt.trim()
      : null

  // ── 9. IIIF manifest URL ──────────────────────────────────────────────────
  const manifestUrl = iiifManifestUrl(fullArk, source)

  // ── 9b. OCR availability ──────────────────────────────────────────────────
  // The MCP reports a text layer via `ocr_available`. Preserve true/false as
  // given; leave null (unknown) when the field is absent rather than guessing.
  const ocrAvailable =
    typeof mcp.ocr_available === "boolean" ? mcp.ocr_available : null

  // ── 10. rawMetadata ───────────────────────────────────────────────────────
  // Preserve the full MCP payload so we can re-normalize without re-fetching.
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
 * Normalize a batch of MCP document detail records, silently dropping those
 * that normalizeDocument rejects.
 *
 * Rejection cases (per plan §TASK constraints):
 *   - `ark` missing or starts with "temp-work/"  → normalizeDocument returns null
 *   - `title` absent AND no useful `creator` fallback  → normalizeDocument returns null
 */
export function normalizeMany(
  mcps: BnfMcpDocumentDetail[],
  opts?: { unknownDocTypeHook?: (raw: string, source: string) => void },
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
