// lib/async/periodic.ts
// The background sweeps instrumentation.ts starts (resolver, canonicalizer,
// ingest watchdog). Each runs under a name, at most once: a second start —
// dev hot-reload re-running register() — stops the previous timer instead of
// stacking a second one. Timers are unref'd so a sweep never holds the
// process open. A failed run is logged and the next tick runs again (each
// sweep is idempotent and self-healing by design); it never kills the timer.
// The OCR-quality sync keeps its own lifecycle (lib/documents/ocr-sync.ts):
// it also aborts an in-flight drain and listens to the commit signal.

/** The stop handle of each running sweep, by name. */
const running = new Map<string, () => void>()

export function startPeriodic(
  name: string,
  intervalMs: number,
  run: () => Promise<void>,
): { stop: () => void } {
  running.get(name)?.()
  const timer = setInterval(() => {
    void run().catch((err: unknown) => {
      console.error(`[${name}] periodic run failed:`, err)
    })
  }, intervalMs)
  timer.unref()
  const stop = () => {
    clearInterval(timer)
    if (running.get(name) === stop) running.delete(name)
  }
  running.set(name, stop)
  return { stop }
}

/** Names of the sweeps currently running — for the tests. */
export function runningPeriodics(): string[] {
  return [...running.keys()]
}
