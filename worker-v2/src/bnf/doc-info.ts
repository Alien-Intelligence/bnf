/**
 * normalizeCachedDocInfo — the ONE way a cached `meta/<slug>.json` blob
 * (keys.metadata) is read back into a BnfDocInfo. Pure, no I/O.
 *
 * Blobs written before the OCR-quality release (plan D5,
 * ai-memories/tech/repos/bnf/feedback-2026-09-29) carry no `ocrRate`. For a
 * manifest-sourced blob the full manifest metadata pairs are still under
 * `raw.metadata` (client.ts docInfoFromManifest), so the "Taux OCR" value is
 * recoverable WITHOUT a BnF call; an OAI-sourced blob never had one → null.
 *
 * Every field is validated structurally rather than cast: a blob with an
 * `ocrRate` of the wrong type, or without an `ark`, is a corrupt cache entry
 * and throws — never coerced into a default (CLAUDE_ERROR_PATTERNS §1/§11).
 */
import type { BnfDocInfo } from "./types.js";
import { metadataValue, ocrRateValue, parseOcrRate, TAUX_OCR_LABELS } from "./parse.js";

const MANIFEST_SOURCE = "iiif_manifest";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function corrupt(ark: string | null, detail: string): Error {
  return new Error(`corrupt cached BnfDocInfo${ark ? ` for ${ark}` : ""}: ${detail}`);
}

function nullableString(blob: Record<string, unknown>, key: string, ark: string): string | null {
  const v = blob[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw corrupt(ark, `${key} must be a string or null, got ${typeof v}`);
  return v;
}

function nullableNumber(blob: Record<string, unknown>, key: string, ark: string): number | null {
  const v = blob[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw corrupt(ark, `${key} must be a finite number or null, got ${typeof v}`);
  }
  return v;
}

/**
 * The `{label, value}` pairs of a cached manifest blob's `raw.metadata`. Entries
 * that are not string pairs are skipped (they can never match a label).
 */
function metadataPairs(raw: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; value: string }> = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    if (typeof entry.label === "string" && typeof entry.value === "string") {
      out.push({ label: entry.label, value: entry.value });
    }
  }
  return out;
}

export function normalizeCachedDocInfo(raw: unknown): BnfDocInfo {
  if (!isRecord(raw)) throw corrupt(null, "not an object");
  const ark = raw.ark;
  if (typeof ark !== "string" || ark.length === 0) throw corrupt(null, "missing ark");
  if (typeof raw.ocrAvailable !== "boolean") {
    throw corrupt(ark, `ocrAvailable must be a boolean, got ${typeof raw.ocrAvailable}`);
  }
  if (!isRecord(raw.raw)) throw corrupt(ark, "raw must be an object");

  let ocrRate: number | null;
  if ("ocrRate" in raw) {
    // Written by this release: trust the recorded value, but only if it IS one.
    const v = raw.ocrRate;
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) {
      throw corrupt(ark, `ocrRate must be a number or null, got ${typeof v}`);
    }
    ocrRate = v;
  } else if (raw.raw.source === MANIFEST_SOURCE) {
    // Pre-release manifest blob: the Taux OCR row is still in raw.metadata.
    if (!Array.isArray(raw.raw.metadata)) {
      throw corrupt(ark, "manifest-sourced blob without raw.metadata");
    }
    ocrRate = ocrRateValue(parseOcrRate(metadataValue(metadataPairs(raw.raw.metadata), TAUX_OCR_LABELS)));
  } else {
    // Pre-release OAI blob: OAI-PMH publishes no Taux OCR.
    ocrRate = null;
  }

  return {
    ark,
    title: nullableString(raw, "title", ark),
    creator: nullableString(raw, "creator", ark),
    date: nullableString(raw, "date", ark),
    docType: nullableString(raw, "docType", ark),
    subtype: nullableString(raw, "subtype", ark),
    ocrAvailable: raw.ocrAvailable,
    ocrRate,
    pageCount: nullableNumber(raw, "pageCount", ark),
    iiifManifestUrl: nullableString(raw, "iiifManifestUrl", ark),
    lang: nullableString(raw, "lang", ark),
    raw: raw.raw,
  };
}
