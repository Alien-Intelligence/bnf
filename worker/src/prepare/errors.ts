/**
 * Typed error hierarchy for the Gallica HTTP client.
 *
 * The ingest worker classifies failures into two buckets:
 *
 *   - `TransientBnfError`  — retry-worthy (network blip, 5xx, 429, timeout).
 *   - `PermanentBnfError`  — terminal for this ARK (404, malformed ark, bad
 *     request). No amount of retrying will change the outcome.
 *
 * The runner uses these classes to decide whether to rethrow (and let pg-boss
 * back off and retry the whole doc-job) or mark the doc-job failed terminally.
 */

export class TransientBnfError extends Error {
  public readonly is429: boolean;
  public readonly status: number | null;

  constructor(
    public readonly cause: string,
    opts: { is429?: boolean; status?: number | null; hint?: string } = {},
  ) {
    super(opts.hint ? `${cause} (${opts.hint})` : cause);
    this.name = "TransientBnfError";
    this.is429 = opts.is429 === true;
    this.status = opts.status ?? null;
  }
}

export class PermanentBnfError extends Error {
  public readonly status: number | null;

  constructor(
    public readonly cause: string,
    opts: { status?: number | null; hint?: string } = {},
  ) {
    super(opts.hint ? `${cause} (${opts.hint})` : cause);
    this.name = "PermanentBnfError";
    this.status = opts.status ?? null;
  }
}

/**
 * Best-effort classifier used by the runner: anything not explicitly permanent
 * is treated as transient (network-level errors don't always wrap cleanly).
 */
export function isTransient(err: unknown): boolean {
  if (err instanceof TransientBnfError) return true;
  if (err instanceof PermanentBnfError) return false;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("timeout") ||
      msg.includes("econn") ||
      msg.includes("network") ||
      msg.includes("socket hang up") ||
      msg.includes("fetch failed")
    ) {
      return true;
    }
  }
  // Be optimistic: unknown errors retry by default. The retry policy itself
  // bounds the cost (max 3 attempts at the pg-boss layer).
  return true;
}
