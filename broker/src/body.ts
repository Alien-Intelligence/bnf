/**
 * Upstream-body truncation guard (2026-08-13 incident).
 *
 * `fetch().arrayBuffer()` resolves with a silent PREFIX when a chunked
 * upstream body ends in a clean connection close — and this broker would then
 * mirror that prefix as a complete response (its own content-length matches
 * the prefix), letting the worker cache corrupt bytes forever (truncated folio
 * JPEGs poisoned the shared S3 cache; Mistral 400'd whole batches). When the
 * upstream DECLARED a length, verify the buffered body matches it; a mismatch
 * must surface as a transport failure (502 → the caller retries), never as a
 * mirrorable body. No declared length → nothing verifiable here; the worker's
 * content validation (JPEG EOI) is the second belt.
 */
export function truncatedBodyError(
  bodyLength: number,
  contentLengthHeader: string | null,
): string | null {
  if (contentLengthHeader === null) return null;
  const declared = Number(contentLengthHeader);
  if (!Number.isFinite(declared) || declared < 0) return null; // junk header — nothing to verify
  if (bodyLength === declared) return null;
  return `upstream body truncated: got ${bodyLength} of ${declared} declared bytes`;
}
