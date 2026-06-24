/**
 * ARK helpers. ARKs look like "ark:/12148/btv1b9015469h". The trailing
 * identifier is the only stable, opaque key — everything before it is
 * always the same for BnF.
 */

const ARK_RE = /^ark:\/12148\/([A-Za-z0-9._-]+)$/;

/** Extract the BnF-internal identifier (e.g. "btv1b9015469h") from a full ARK. */
export function arkToSlug(ark: string): string {
  const m = ARK_RE.exec(ark.trim());
  if (m) return m[1]!;
  // Fallback: replace path separators only; never invent or transform content.
  return ark.replace(/\//g, "-");
}

/** Compose the standard blob-key prefix for a doc under a project. */
export function docPrefix(projectId: string, ark: string): string {
  return `projects/${projectId}/docs/${arkToSlug(ark)}`;
}

/** Compose blob keys for the three persisted artifacts of a doc. */
export function docKeys(projectId: string, ark: string): {
  docMd: string;
  docJson: string;
  chunksJsonl: string;
  vectors: string;
} {
  const prefix = docPrefix(projectId, ark);
  return {
    docMd: `${prefix}/doc.md`,
    docJson: `${prefix}/doc.json`,
    chunksJsonl: `${prefix}/chunks.jsonl`,
    // Cached embedding vectors ({contentHash, vectors[]}) so a re-ingest of
    // unchanged content skips the (expensive) RunPod embed call. See upsert.ts.
    vectors: `${prefix}/vectors.json`,
  };
}
