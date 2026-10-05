/**
 * `SendOpts.attemptsSpent` (core/types.ts), shared by both transports so they
 * cannot disagree on what a hand-back's copy is. The count is carried by the
 * transport's own job fields, never by the payload (a payload is the
 * producer's data and can hold anything).
 */

/** A spent-attempt count must be a non-negative integer — anything else is a caller bug. */
export function assertAttemptsSpent(spent: number): void {
  if (!Number.isInteger(spent) || spent < 0) {
    throw new Error(`attemptsSpent must be a non-negative integer, got ${spent}`);
  }
}

/**
 * pg-boss: the deliveries a job's earlier copies spent, read off the job row —
 * a copy is sent with `retry_limit = policy − spent`, so `policy − retry_limit`
 * recovers it. Never negative (a policy LOWERED since the job was sent leaves
 * a job with more budget than the policy: it has spent nothing).
 */
export function spentFromRetryLimit(policyRetryLimit: number, jobRetryLimit: number): number {
  return Math.max(0, policyRetryLimit - jobRetryLimit);
}
