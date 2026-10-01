/**
 * Pure BnF parsers — every function here is a deterministic transform over a
 * string/JSON/XML input with NO network and NO environment access. They are
 * lifted verbatim from V1's worker/src/prepare/bnf-api.ts (and slug.ts) so the
 * proven OAI / IIIF / ALTO extraction logic stays byte-identical to the
 * production pipeline. Keeping them standalone (not methods on LiveBnfClient)
 * is what lets the unit suite exercise them with inline fixtures.
 *
 * The concrete client (./client.ts) imports these and supplies the HTTP bytes;
 * it owns the only IO. The split mirrors the V2 contract: stages depend on the
 * BnfClient interface, the client depends on the broker, the parsers depend on
 * nothing.
 */
import { XMLParser } from "fast-xml-parser";

import type { AltoFolio, Manifest, ManifestCanvas } from "./types.js";
import { PermanentBnfError, TransientBnfError } from "./errors.js";

// ---------------------------------------------------------------------------
// XML parsers — single instance each, configured once (verbatim from V1).
// ---------------------------------------------------------------------------

/** OAIRecord/OAI-PMH parser: preserves attributes so we can pick dc:type[xml:lang="fre"]. */
export const oaiParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // We want repeated dc:* tags to come through as arrays; the parser handles
  // single-vs-array per element but tagging the common repeating tags as
  // always-array keeps the consumer simple.
  isArray: (name) =>
    name === "dc:type" ||
    name === "dc:creator" ||
    name === "dc:contributor" ||
    name === "dc:subject" ||
    name === "dc:language" ||
    name === "dc:title" ||
    name === "dc:format" ||
    name === "dc:description" ||
    name === "setSpec",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

/** ALTO parser: preserves @_CONTENT on String tags and TextLine structure. */
const altoParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) =>
    name === "String" ||
    name === "TextLine" ||
    name === "TextBlock" ||
    name === "Page",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

// ---------------------------------------------------------------------------
// ARK helpers (ported from V1 slug.ts)
// ---------------------------------------------------------------------------

const ARK_RE = /^ark:\/12148\/([A-Za-z0-9._-]+)$/;

/** Extract the BnF-internal identifier (e.g. "btv1b9015469h") from a full ARK. */
export function arkToSlug(ark: string): string {
  const m = ARK_RE.exec(ark.trim());
  if (m) return m[1]!;
  // Fallback: replace path separators only; never invent or transform content.
  return ark.replace(/\//g, "-");
}

/**
 * Normalize and validate an ARK into its canonical "ark:/12148/<id>" form.
 * A non-canonical ARK is a permanent classification — no retry recovers it.
 */
export function ensureCanonicalArk(ark: string): string {
  const trimmed = ark.trim();
  if (!trimmed.startsWith("ark:/12148/")) {
    throw new PermanentBnfError("bad_ark", {
      hint: `expected "ark:/12148/<id>", got: ${ark}`,
    });
  }
  return trimmed;
}

/**
 * True for BnF catalogue-notice ARKs (`ark:/12148/cb…`) — bibliographic or
 * authority records, not digitized documents. They have no IIIF surface and no
 * pages, so any attempt to fetch text resets the connection. Routed to a
 * permanent "not_digitized" classification by the client.
 */
export function isCatalogueNotice(canonicalArk: string): boolean {
  return /^ark:\/12148\/cb/.test(canonicalArk);
}

// ---------------------------------------------------------------------------
// XML scalar helpers
// ---------------------------------------------------------------------------

export function firstOrNull<T>(v: T | T[] | undefined | null): T | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length > 0 ? (v[0] ?? null) : null;
  return v;
}

/**
 * Pull a text value out of a possibly-attribute-decorated XML element.
 * fast-xml-parser yields either a bare string or `{ "#text": "...", "@_lang": "..." }`.
 */
export function textOf(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === "string") return node.trim() || null;
  if (typeof node === "object") {
    const t = (node as Record<string, unknown>)["#text"];
    if (typeof t === "string") return t.trim() || null;
  }
  return null;
}

/**
 * Pick the language-tagged dc:type if one exists (xml:lang="fre"), else the
 * first entry. Gallica often emits two: a short code and a French label.
 */
export function pickDcType(types: unknown): string | null {
  if (!Array.isArray(types)) return textOf(types);
  for (const t of types) {
    if (
      t &&
      typeof t === "object" &&
      ((t as Record<string, unknown>)["@_xml:lang"] === "fre" ||
        (t as Record<string, unknown>)["@_lang"] === "fre")
    ) {
      const v = textOf(t);
      if (v) return v;
    }
  }
  return textOf(types[0]);
}

/**
 * The Gallica typedoc subcategory token ("fascicules", "titres", "plan",
 * "estampes", …) from a typedoc tail ("periodiques:fascicules"), or null when
 * there is no second segment. Stored as the document `subtype` — a finer,
 * Gallica-native facet than docType.
 */
export function typedocSubtype(typedoc: string | null): string | null {
  if (!typedoc) return null;
  const parts = typedoc.toLowerCase().split(":");
  // parts[1] is the subcategory tail; under noUncheckedIndexedAccess it is
  // `string | undefined`, so bind it explicitly rather than re-index after the
  // length check (which TS does not track as a narrowing).
  const tail = parts[1];
  return tail != null && tail !== "" ? tail : null;
}

/**
 * The Gallica typedoc tail ("periodiques:fascicules") from the OAI record
 * header <setSpec> values, or null. The OAI <dc:type> values are generic
 * physical-form labels ("texte") that don't discriminate a periodical from a
 * monograph; the typedoc setSpec is the authoritative signal.
 */
export function pickTypedocFromHeader(header: unknown): string | null {
  if (!header || typeof header !== "object") return null;
  const specs = (header as Record<string, unknown>)["setSpec"];
  const arr = Array.isArray(specs) ? specs : specs != null ? [specs] : [];
  for (const s of arr) {
    const m = textOf(s)?.match(/^gallica:typedoc:(.+)$/);
    if (m) return m[1]!;
  }
  return null;
}

export function pickFirstLanguage(langs: unknown): string | null {
  if (!Array.isArray(langs)) return textOf(langs);
  for (const l of langs) {
    const v = textOf(l);
    if (v) return v;
  }
  return null;
}

/**
 * Gallica encodes the total view count inside a dc:format string like
 * "Nombre total de vues :  12". When the canonical field is missing this is
 * the only way to recover the page count without a second Pagination call.
 */
export function extractPageCountFromFormat(formats: unknown): number | null {
  const list = Array.isArray(formats) ? formats : formats != null ? [formats] : [];
  for (const f of list) {
    const s = textOf(f);
    if (!s) continue;
    const m = /Nombre\s+total\s+de\s+vues\s*:\s*(\d+)/i.exec(s);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * OCR-availability signal: true if ANY <dc:description> announces a text layer
 * ("Avec mode texte"). Must scan all descriptions — Gallica emits several
 * (e.g. "Contient une table des matières" THEN "Avec mode texte"), so checking
 * only the first would miss it.
 */
export function descriptionsHaveModeTexte(descriptions: unknown): boolean {
  const list = Array.isArray(descriptions)
    ? descriptions
    : descriptions != null
      ? [descriptions]
      : [];
  for (const d of list) {
    const s = textOf(d);
    if (s != null && /mode\s+texte/i.test(s)) return true;
  }
  return false;
}

export function parseIntOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// IIIF Presentation v3 manifest parsing (partner API)
// ---------------------------------------------------------------------------

/** Parse an IIIF Presentation v3 manifest into the V2 `Manifest` shape. */
export function parseV3Manifest(
  json: Record<string, unknown>,
  maxCanvases: number,
): Manifest {
  const title = iiifV3Label(json.label);
  const items = Array.isArray(json.items) ? json.items : [];

  // Parse each canvas, deriving its folio ordre strictly from the IIIF canvas id
  // (".../f<N>/canvas"). A canvas whose id carries no folio number is not a
  // paginated image: for BnF audio/video docs these are media playback surfaces
  // (e.g. ".../canvas/4-4-6-2-4") with no fetchable image at all.
  type ParsedCanvas = Omit<ManifestCanvas, "ordre"> & { fOrdre: number | null };
  const parsed: ParsedCanvas[] = [];
  for (const c of items) {
    if (!c || typeof c !== "object") continue;
    const obj = c as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : null;
    const m = id ? /\/f(\d+)(?:\/|$)/.exec(id) : null;
    parsed.push({
      fOrdre: m ? parseInt(m[1]!, 10) : null,
      label: iiifV3Label(obj.label),
      width: typeof obj.width === "number" ? obj.width : null,
      height: typeof obj.height === "number" ? obj.height : null,
    });
  }

  // The fan-in counts distinct (docJobId, ordre) folios, so `ordre` MUST be unique
  // across canvases or the doc hangs forever (live bug, 2026-06-26: a "document
  // sonore" whose two audio canvases fell back to positions 1,2 and collided with
  // its image folios f1,f2 → pagesExpected 6 but only 4 distinct folios reachable).
  // When the manifest carries any real folio id, drop the folio-less media canvases
  // (the image fetch URL is folio-numbered — a folio-less canvas is unfetchable
  // regardless). Only a uniformly id-less legacy manifest falls back to 1-based
  // position (unique by construction). Dedupe by ordre as a final guard.
  const hasFolioIds = parsed.some((p) => p.fOrdre !== null);
  const canvases: ManifestCanvas[] = [];
  const seen = new Set<number>();
  parsed.forEach((p, i) => {
    if (hasFolioIds && p.fOrdre === null) return; // non-paginated media (audio/video)
    const ordre = p.fOrdre ?? i + 1;
    if (seen.has(ordre)) return; // duplicate folio id — keep the first
    seen.add(ordre);
    // V2 drops imageServiceUrl: the client builds the image URL from ark+ordre.
    canvases.push({ ordre, label: p.label, width: p.width, height: p.height });
  });
  return {
    title,
    metadata: parseV3ManifestMetadata(json.metadata),
    totalPages: canvases.length,
    canvases: canvases.slice(0, maxCanvases),
  };
}

/** Coerce a v3 language map ({"fr":["…"],"none":["…"]}) to one string (fr preferred). */
export function iiifV3Label(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const langs = Object.keys(o);
    const pick =
      langs.find((l) => /^fr/i.test(l)) ?? langs.find((l) => l === "none") ?? langs[0];
    if (pick) {
      const arr = o[pick];
      if (Array.isArray(arr) && typeof arr[0] === "string") return arr[0].trim() || null;
      if (typeof arr === "string") return arr.trim() || null;
    }
  }
  return null;
}

/**
 * Flatten a v3 manifest `metadata[]` (label/value are language maps) to pairs.
 * The VALUE keeps every element of a multi-valued field, joined " | " — BnF puts
 * the discriminating tokens in the tail: `Type = [texte, publication en série
 * imprimée]` (the press signal) and `Format = […, Nombre total de vues : N]`.
 * `iiifV3Label` would drop everything after the first element, losing them.
 */
export function parseV3ManifestMetadata(
  raw: unknown,
): Array<{ label: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; value: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const label = iiifV3Label(e.label);
    const value = iiifV3Values(e.value).join(" | ");
    if (label && value) out.push({ label, value });
  }
  return out;
}

/** Every string in a v3 language map ({"fr":["a","b"]} → ["a","b"]); fr preferred. */
export function iiifV3Values(v: unknown): string[] {
  if (v == null) return [];
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.flatMap(iiifV3Values);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const langs = Object.keys(o);
    const pick =
      langs.find((l) => /^fr/i.test(l)) ?? langs.find((l) => l === "none") ?? langs[0];
    return pick ? iiifV3Values(o[pick]) : [];
  }
  return [];
}

/** First metadata value whose (case-insensitive) label matches any candidate. */
export function metadataValue(
  metadata: Array<{ label: string; value: string }>,
  labels: readonly string[],
): string | null {
  const wanted = new Set(labels.map((l) => l.toLowerCase().trim()));
  for (const { label, value } of metadata) {
    if (wanted.has(label.toLowerCase().trim())) {
      return value.trim() || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// "Taux OCR" — the document-level OCR rate the IIIF manifest publishes
// ---------------------------------------------------------------------------

/**
 * Manifest metadata labels (case-insensitive, see metadataValue) under which
 * BnF publishes the document-level OCR rate. The first two are Gallica's French
 * labels; "ocr rate" is the English label mcp-bnf also matches
 * (MCPs/mcp-bnf/src/clients/bnf_document_client.py:141-159). Presence of the row
 * is the text-lane routing signal (BnfDocInfo.ocrAvailable); its VALUE is
 * BnfDocInfo.ocrRate.
 */
export const TAUX_OCR_LABELS = ["taux ocr", "taux d'ocr", "ocr rate"] as const;

/**
 * Parse a "Taux OCR" metadata value ("78.21 %", "89,59 %", "100 %") into a
 * fraction in [0, 1], rounded to 4 decimals — a port of mcp-bnf's
 * `BnfDocumentClient._extract_ocr_rate` (bnf_document_client.py:141-159: strip
 * the %, comma → dot, /100, round 4) with two additions that port lacks:
 *   - a [0, 100] range check — "150 %" is null here, 1.5 there (bug B7, reported
 *     against mcp-bnf separately; it is frozen this round);
 *   - the " | " multi-value joiner of parseV3ManifestMetadata is split and the
 *     first value taken.
 * Anything unparsable or out of range is null — never a default, never coerced.
 */
export function parseOcrRate(raw: string | null): number | null {
  if (raw === null) return null;
  const first = raw.split(" | ")[0] ?? "";
  const cleaned = first.replace(/%/g, "").replace(/,/g, ".").trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const pct = Number(cleaned);
  if (pct < 0 || pct > 100) return null;
  return round4(pct / 100);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// ALTO text extraction + per-folio word confidence
// ---------------------------------------------------------------------------

/**
 * Everything one folio's ALTO XML yields: the extracted text (unchanged from
 * the V1 extraction) plus the word-confidence statistics the OCR-quality
 * feature rests on (plan D1 — ai-memories/tech/repos/bnf/feedback-2026-09-29).
 */
export interface AltoParse {
  text: string;
  /** <String> elements with a non-empty CONTENT — the words in `text`. */
  wordCount: number;
  /** Subset of those carrying a WC that parses to a finite number in [0, 1]. */
  scoredWordCount: number;
  /**
   * Mean WC over the scored words, rounded to 4 decimals. Null when no word is
   * scored (an ALTO without WC, or an empty folio) — never a default 0, which
   * would read as "every word unreliable".
   */
  meanWordConfidence: number | null;
  /**
   * WC attributes that were present but non-numeric or outside [0, 1]. Excluded
   * from the mean and never coerced; the caller logs the count (alto_invalid_wc).
   */
  invalidWcCount: number;
}

/** The AltoFolio for a folio BnF has no text for (ALTO 404, blank body). */
export function emptyAltoFolio(): AltoFolio {
  return {
    text: "",
    empty: true,
    quality: { v: 1, wordCount: 0, scoredWordCount: 0, meanWc: null },
    invalidWcCount: 0,
  };
}

/** Mutable tally threaded through the collectLines walk. */
interface AltoStats {
  words: number;
  scored: number;
  wcSum: number;
  invalid: number;
}

/**
 * Parse ALTO XML: concatenate <String CONTENT="..."> across <TextLine> tags
 * (words joined with spaces, lines with newlines — byte-identical to the V1
 * extraction) and accumulate the WC statistics in the same pass.
 *
 * Structurally-empty ALTO (an <alto> root with no Layout / PrintSpace / words)
 * is a legitimately text-less folio: `{text: "", wordCount: 0,
 * meanWordConfidence: null}`.
 *
 * A body the parser cannot read, or one that parses but has no <alto> root,
 * throws TransientBnfError("alto_parse_failed") (B9). fast-xml-parser without
 * validation only throws on a truncated tag/attribute — the shape a chunked
 * response closed mid-stream produces — and it reads an HTML error page served
 * as 200 into `{html: …}` without complaint. Neither is a text-less page; both
 * used to come back as "" and be recorded as one. Transient so the fetch stage
 * retries, and a persistent one counts the folio as lost (fail-ratio) instead
 * of silently shipping an empty page.
 */
export function parseAlto(xml: string): AltoParse {
  let parsed: unknown;
  try {
    parsed = altoParser.parse(xml);
  } catch (e) {
    throw new TransientBnfError("alto_parse_failed", {
      hint: e instanceof Error ? e.message : String(e),
    });
  }
  if (parsed === null || typeof parsed !== "object" || !("alto" in parsed)) {
    throw new TransientBnfError("alto_parse_failed", {
      hint: "body parsed but has no <alto> root element",
    });
  }
  const root = (parsed as Record<string, unknown>).alto;
  const layout =
    root !== null && typeof root === "object"
      ? ((root as Record<string, unknown>).Layout as Record<string, unknown> | undefined)
      : undefined;
  const pages = layout && Array.isArray(layout.Page) ? (layout.Page as unknown[]) : [];

  const lines: string[] = [];
  const stats: AltoStats = { words: 0, scored: 0, wcSum: 0, invalid: 0 };
  for (const page of pages) {
    if (!page || typeof page !== "object") continue;
    const printSpace = (page as Record<string, unknown>).PrintSpace as
      | Record<string, unknown>
      | undefined;
    if (!printSpace) continue;
    collectLines(printSpace, lines, stats);
  }
  return {
    text: lines.join("\n").trim(),
    wordCount: stats.words,
    scoredWordCount: stats.scored,
    meanWordConfidence: stats.scored > 0 ? round4(stats.wcSum / stats.scored) : null,
    invalidWcCount: stats.invalid,
  };
}

/**
 * A WC attribute as a number in [0, 1], or null when it is not one. BnF writes
 * WC as "1" or "0.34" (parseAttributeValue is off, so it arrives as a string).
 * Only a plain decimal is accepted — Number("") is 0 and Number("0x1") is 1,
 * neither of which is a confidence anyone wrote.
 */
function parseWordConfidence(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

/**
 * Walk an ALTO subtree collecting one string per TextLine and tallying each
 * word's WC. TextBlocks group TextLines and TextLines group Strings; the spec
 * also allows ComposedBlock containers — we recurse defensively.
 */
function collectLines(node: Record<string, unknown>, out: string[], stats: AltoStats): void {
  const textBlocks = Array.isArray(node.TextBlock) ? (node.TextBlock as unknown[]) : [];
  for (const tb of textBlocks) {
    if (!tb || typeof tb !== "object") continue;
    const tbObj = tb as Record<string, unknown>;
    const textLines = Array.isArray(tbObj.TextLine) ? (tbObj.TextLine as unknown[]) : [];
    for (const tl of textLines) {
      if (!tl || typeof tl !== "object") continue;
      const strings = Array.isArray((tl as Record<string, unknown>).String)
        ? ((tl as Record<string, unknown>).String as unknown[])
        : [];
      const words: string[] = [];
      for (const s of strings) {
        if (!s || typeof s !== "object") continue;
        const attrs = s as Record<string, unknown>;
        const content = attrs["@_CONTENT"];
        if (typeof content !== "string" || content.length === 0) continue;
        words.push(content);
        stats.words += 1;
        // A WC on an empty String never reaches here: only words carry a score.
        const wc = attrs["@_WC"];
        if (wc === undefined) continue;
        const confidence = parseWordConfidence(wc);
        if (confidence === null) {
          stats.invalid += 1;
        } else {
          stats.scored += 1;
          stats.wcSum += confidence;
        }
      }
      if (words.length > 0) out.push(words.join(" "));
    }
    // ALTO can also nest ComposedBlock → TextBlock; recurse.
    if (Array.isArray(tbObj.ComposedBlock)) {
      for (const cb of tbObj.ComposedBlock as unknown[]) {
        if (cb && typeof cb === "object") {
          collectLines(cb as Record<string, unknown>, out, stats);
        }
      }
    }
  }
  // PrintSpace might also host ComposedBlock at the top level.
  if (Array.isArray(node.ComposedBlock)) {
    for (const cb of node.ComposedBlock as unknown[]) {
      if (cb && typeof cb === "object") {
        collectLines(cb as Record<string, unknown>, out, stats);
      }
    }
  }
}
