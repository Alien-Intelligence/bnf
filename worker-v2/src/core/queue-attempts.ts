/**
 * `SendOpts.attemptsSpent` (core/types.ts), shared by both transports so they
 * cannot disagree on what a hand-back's copy is.
 */

/** A spent-attempt count must be a non-negative integer — anything else is a caller bug. */
export function assertAttemptsSpent(spent: number): void {
  if (!Number.isInteger(spent) || spent < 0) {
    throw new Error(`attemptsSpent must be a non-negative integer, got ${spent}`);
  }
}

/**
 * pg-boss keeps no field of ours on a job but its `data`, so the spent count
 * rides there under this key, beside the payload's own fields (so the
 * read-model's `data->>'docJobId'` lookups still see the payload). The
 * transport strips it before the handler sees the payload.
 */
export const ATTEMPTS_SPENT_KEY = "__attemptsSpent";

/** Is `value` a plain JSON object (the only payload shape a copy can carry the count on)? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The job data of a copy: the payload's fields plus the spent count. */
export function withAttemptsSpent(payload: unknown, spent: number): Record<string, unknown> {
  assertAttemptsSpent(spent);
  if (!isPlainObject(payload)) {
    throw new Error("attemptsSpent needs an object payload to ride on");
  }
  if (ATTEMPTS_SPENT_KEY in payload) {
    throw new Error(`a payload must not carry the transport's own key ${ATTEMPTS_SPENT_KEY}`);
  }
  return { ...payload, [ATTEMPTS_SPENT_KEY]: spent };
}

/**
 * Take the spent count out of a delivered job's data (0 when absent), removing
 * the key IN PLACE so the handler sees the producer's payload exactly. The
 * data object is the transport's own (freshly parsed from the job row).
 */
export function takeAttemptsSpent(data: unknown): number {
  if (!isPlainObject(data) || !(ATTEMPTS_SPENT_KEY in data)) return 0;
  const raw = data[ATTEMPTS_SPENT_KEY];
  if (typeof raw !== "number") {
    throw new Error(`job data carries a non-numeric ${ATTEMPTS_SPENT_KEY}: ${JSON.stringify(raw)}`);
  }
  assertAttemptsSpent(raw);
  Reflect.deleteProperty(data, ATTEMPTS_SPENT_KEY);
  return raw;
}
