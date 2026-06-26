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

import type { Manifest, ManifestCanvas } from "./types.js";
import { PermanentBnfError } from "./errors.js";

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
  const canvases: ManifestCanvas[] = [];
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    if (!c || typeof c !== "object") continue;
    const obj = c as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : null;
    // v3 canvas id is ".../f<N>/canvas" — derive ordre, else 1-based position.
    const m = id ? /\/f(\d+)(?:\/|$)/.exec(id) : null;
    const ordre = m ? parseInt(m[1]!, 10) : i + 1;
    const label = iiifV3Label(obj.label);
    const width = typeof obj.width === "number" ? obj.width : null;
    const height = typeof obj.height === "number" ? obj.height : null;
    // V2 drops imageServiceUrl: the client builds the image URL from ark+ordre.
    canvases.push({ ordre, label, width, height });
  }
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

/** Flatten a v3 manifest `metadata[]` (label/value are language maps) to pairs. */
export function parseV3ManifestMetadata(
  raw: unknown,
): Array<{ label: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; value: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const label = iiifV3Label(e.label);
    const value = iiifV3Label(e.value);
    if (label && value) out.push({ label, value });
  }
  return out;
}

/** First metadata value whose (case-insensitive) label matches any candidate. */
export function metadataValue(
  metadata: Array<{ label: string; value: string }>,
  labels: string[],
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
// ALTO text extraction
// ---------------------------------------------------------------------------

/**
 * Extract text from ALTO XML: concatenate <String CONTENT="..."> across
 * <TextLine> tags, joining words with spaces and lines with newlines. Returns
 * "" for malformed / structurally-empty ALTO (a legitimately text-less folio).
 */
export function parseAltoText(xml: string): string {
  let parsed: unknown;
  try {
    parsed = altoParser.parse(xml);
  } catch {
    return "";
  }
  const root = (parsed as Record<string, unknown>).alto as
    | Record<string, unknown>
    | undefined;
  if (!root) return "";
  const layout = root.Layout as Record<string, unknown> | undefined;
  if (!layout) return "";
  const pages = Array.isArray(layout.Page) ? (layout.Page as unknown[]) : [];

  const lines: string[] = [];
  for (const page of pages) {
    if (!page || typeof page !== "object") continue;
    const printSpace = (page as Record<string, unknown>).PrintSpace as
      | Record<string, unknown>
      | undefined;
    if (!printSpace) continue;
    collectLines(printSpace, lines);
  }
  return lines.join("\n").trim();
}

/**
 * Walk an ALTO subtree collecting one string per TextLine. TextBlocks group
 * TextLines and TextLines group Strings; the spec also allows ComposedBlock
 * containers — we recurse defensively.
 */
function collectLines(node: Record<string, unknown>, out: string[]): void {
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
        const content = (s as Record<string, unknown>)["@_CONTENT"];
        if (typeof content === "string" && content.length > 0) {
          words.push(content);
        }
      }
      if (words.length > 0) out.push(words.join(" "));
    }
    // ALTO can also nest ComposedBlock → TextBlock; recurse.
    if (Array.isArray(tbObj.ComposedBlock)) {
      for (const cb of tbObj.ComposedBlock as unknown[]) {
        if (cb && typeof cb === "object") {
          collectLines(cb as Record<string, unknown>, out);
        }
      }
    }
  }
  // PrintSpace might also host ComposedBlock at the top level.
  if (Array.isArray(node.ComposedBlock)) {
    for (const cb of node.ComposedBlock as unknown[]) {
      if (cb && typeof cb === "object") {
        collectLines(cb as Record<string, unknown>, out);
      }
    }
  }
}
