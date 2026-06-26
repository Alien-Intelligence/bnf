/**
 * Typed BnF error hierarchy (ported verbatim from V1 worker/src/prepare/errors.ts).
 *
 *   - TransientBnfError — retry-worthy (network blip, 5xx, 429, timeout).
 *   - PermanentBnfError — terminal for this ARK (404, malformed ark, 403 forbidden,
 *     catalogue notice). No amount of retrying changes the outcome.
 *
 * The stage base coerces any thrown error into a non-terminal fail (→ retry); the
 * concrete stages catch PermanentBnfError explicitly and turn it into a terminal
 * fail / skip so a doomed doc never burns the retry budget (V1's 403-loop fix).
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

/** Best-effort classifier: anything not explicitly permanent is treated transient. */
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
  return true;
}
