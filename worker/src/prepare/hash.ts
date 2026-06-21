/**
 * Canonical sha256 for the DocMetadata + chunkCount payload.
 *
 * Used downstream (Track 3) to skip re-ingest when the prepared doc is
 * byte-identical to a previous run. "Canonical" means JSON keys are sorted at
 * every nesting level, so two semantically-equal objects always hash the same.
 */
import { createHash } from "node:crypto";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortValue(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

/** Stable JSON stringification: keys sorted, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** sha256 of canonical(value). */
export function sha256OfCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
