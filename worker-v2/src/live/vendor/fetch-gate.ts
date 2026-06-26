/**
 * Process-global concurrency gate for worker→broker fetches.
 *
 * The broker is the sole RATE authority (its token bucket paces and sheds against
 * BnF's shared quota). This gate is a *concurrency* bound only: it caps how many
 * requests the worker keeps in flight at once, with NO rate logic of its own — so
 * there is no double-throttle. Its single job is to keep the broker's bucket fed
 * continuously, independent of the per-document lifecycle.
 *
 * Why it lives below the doc loop: a document parked in chunk/embed/index is not
 * holding any fetch permits, so other documents' pages fill them and the broker
 * stays saturated. Effective fetch concurrency stops being
 * `WORKER_CONCURRENCY × per-doc pool` (which collapses to ~0 during embed/index)
 * and becomes a single, stable `BNF_FETCH_CONCURRENCY`.
 *
 * Sizing: permits = cap × target-acquire-wait-seconds / 60, with headroom. At the
 * 300/min cap, 8–12 holds ~1s broker acquire-wait with freeze≈0/shed≈0. Scaling
 * to a 3000/min quota is a config flip only: broker BNF_GLOBAL_RPM=3000 + worker
 * BNF_FETCH_CONCURRENCY≈48. See ai-memories bnf-fetch-saturation.
 */

/** Default in-flight permit count when BNF_FETCH_CONCURRENCY is unset (300/min cap). */
const DEFAULT_PERMITS = 12;

const PERMITS = (() => {
  const raw = process.env.BNF_FETCH_CONCURRENCY;
  if (raw == null || raw.trim() === "") return DEFAULT_PERMITS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_PERMITS;
})();

let available = PERMITS;
const waiters: Array<() => void> = [];

/** The configured number of concurrent in-flight broker fetches. */
export function fetchGatePermits(): number {
  return PERMITS;
}

/**
 * Run `fn` while holding one fetch permit. Acquires before `fn` starts and
 * releases in `finally` — so the permit is returned whether `fn` resolves or
 * throws. When a waiter is queued, the released permit is handed directly to the
 * earliest waiter (FIFO, no starvation) rather than bouncing through the pool.
 */
export async function withFetchPermit<T>(fn: () => Promise<T>): Promise<T> {
  if (available > 0) {
    available--;
  } else {
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) {
      next(); // hand the permit straight to the next waiter
    } else {
      available++;
    }
  }
}
