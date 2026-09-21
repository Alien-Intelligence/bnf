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
 *
 * The comparison is only valid for an IDENTITY body. `Content-Length` counts
 * the bytes on the wire, and undici decodes `Content-Encoding` transparently
 * before `arrayBuffer()` resolves — so for a compressed response the buffer is
 * the DECODED size and the header is the ENCODED size, two different numbers
 * that were never meant to match. Comparing them read every gzip'd upstream as
 * truncated: `oai.bnf.fr` (the ungated OAI-PMH metadata host) answers
 * `Content-Encoding: gzip` with `Content-Length: 1341` and a 3800-byte decoded
 * body, so the guard 502'd the whole OAI metadata lane from 0.15.2 until this
 * fix. 502 is classed transient, so the caller retried into the same wall
 * forever. Encoded responses simply carry nothing verifiable at this layer.
 */

/**
 * True when the upstream encoded the body, so the buffered length and the
 * declared length describe different things.
 *
 * `Content-Encoding` is a comma-separated list applied in order, and `identity`
 * means "no transformation". Absent, empty, or identity-only → the wire bytes
 * ARE the buffered bytes and the length is verifiable. Anything else (gzip, br,
 * deflate, or a chain of them) is not.
 */
function bodyWasDecoded(contentEncodingHeader: string | null): boolean {
  if (contentEncodingHeader === null) return false;
  return contentEncodingHeader
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== "")
    .some((token) => token !== "identity");
}

export function truncatedBodyError(
  bodyLength: number,
  contentLengthHeader: string | null,
  contentEncodingHeader: string | null,
): string | null {
  if (bodyWasDecoded(contentEncodingHeader)) return null; // encoded — lengths are incomparable
  if (contentLengthHeader === null) return null;
  const declared = Number(contentLengthHeader);
  if (!Number.isFinite(declared) || declared < 0) return null; // junk header — nothing to verify
  if (bodyLength === declared) return null;
  return `upstream body truncated: got ${bodyLength} of ${declared} declared bytes`;
}
