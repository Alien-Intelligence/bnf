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
 * Every field is validated structurally rather than cast. A missing field, a
 * value of the wrong type or out of range, an unknown `raw.source`, or a
 * malformed `raw.metadata` entry is a corrupt cache entry: it throws
 * CorruptDocInfoError — never coerced into a default (CLAUDE_ERROR_PATTERNS
 * §1/§11). Callers decide what a corrupt blob means for them (MetadataStage
 * repairs it from BnF; the OCR-quality artifact build fails the document).
 */
import {
  DOC_INFO_SOURCE,
  type BnfDocInfo,
} from "./types.js";
import { metadataValue, ocrRateValue, parseOcrRate, TAUX_OCR_LABELS } from "./parse.js";

/** A cached BnfDocInfo blob that does not have the shape the worker writes. */
export class CorruptDocInfoError extends Error {
  constructor(
    readonly ark: string | null,
    detail: string,
  ) {
    super(`corrupt cached BnfDocInfo${ark ? ` for ${ark}` : ""}: ${detail}`);
    this.name = "CorruptDocInfoError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A key that must be present (written as null when absent upstream). */
function requireKey(blob: Record<string, unknown>, key: string, ark: string): unknown {
  if (!(key in blob)) throw new CorruptDocInfoError(ark, `missing ${key}`);
  return blob[key];
}

function nullableString(blob: Record<string, unknown>, key: string, ark: string): string | null {
  const v = requireKey(blob, key, ark);
  if (v === null) return null;
  if (typeof v !== "string") {
    throw new CorruptDocInfoError(ark, `${key} must be a string or null, got ${typeof v}`);
  }
  return v;
}

function nullablePageCount(blob: Record<string, unknown>, ark: string): number | null {
  const v = requireKey(blob, "pageCount", ark);
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new CorruptDocInfoError(ark, `pageCount must be a non-negative integer or null, got ${String(v)}`);
  }
  return v;
}

/** The `{label, value}` pairs of a cached manifest blob's `raw.metadata`, each validated. */
function metadataPairs(raw: unknown, ark: string): Array<{ label: string; value: string }> {
  if (!Array.isArray(raw)) {
    throw new CorruptDocInfoError(ark, "manifest-sourced blob without a raw.metadata array");
  }
  return raw.map((entry, i) => {
    if (!isRecord(entry) || typeof entry.label !== "string" || typeof entry.value !== "string") {
      throw new CorruptDocInfoError(ark, `raw.metadata[${i}] is not a {label, value} string pair`);
    }
    return { label: entry.label, value: entry.value };
  });
}

/** A recorded ocrRate: a number in [0, 1], or null. */
function recordedOcrRate(v: unknown, ark: string): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new CorruptDocInfoError(ark, `ocrRate must be a number in [0, 1] or null, got ${String(v)}`);
  }
  return v;
}

export function normalizeCachedDocInfo(raw: unknown): BnfDocInfo {
  if (!isRecord(raw)) throw new CorruptDocInfoError(null, "not an object");
  const ark = raw.ark;
  if (typeof ark !== "string" || ark.length === 0) throw new CorruptDocInfoError(null, "missing ark");
  const ocrAvailable = requireKey(raw, "ocrAvailable", ark);
  if (typeof ocrAvailable !== "boolean") {
    throw new CorruptDocInfoError(ark, `ocrAvailable must be a boolean, got ${typeof ocrAvailable}`);
  }
  const rawBlob = requireKey(raw, "raw", ark);
  if (!isRecord(rawBlob)) throw new CorruptDocInfoError(ark, "raw must be an object");
  const source = rawBlob.source;
  if (source !== DOC_INFO_SOURCE.IIIF_MANIFEST && source !== DOC_INFO_SOURCE.OAI_PMH) {
    throw new CorruptDocInfoError(ark, `unknown raw.source ${JSON.stringify(source)}`);
  }

  let ocrRate: number | null;
  if ("ocrRate" in raw) {
    // Written by this release: trust the recorded value, but only if it IS one.
    ocrRate = recordedOcrRate(raw.ocrRate, ark);
  } else if (source === DOC_INFO_SOURCE.IIIF_MANIFEST) {
    // Pre-release manifest blob: the Taux OCR row is still in raw.metadata.
    ocrRate = ocrRateValue(
      parseOcrRate(metadataValue(metadataPairs(rawBlob.metadata, ark), TAUX_OCR_LABELS)),
    );
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
    ocrAvailable,
    ocrRate,
    pageCount: nullablePageCount(raw, ark),
    iiifManifestUrl: nullableString(raw, "iiifManifestUrl", ark),
    lang: nullableString(raw, "lang", ark),
    raw: rawBlob,
  };
}
