// lib/background/guarded-pass.ts
// One periodic background pass with its own overlap guard: a call while the
// previous run is still in flight is skipped (never queued, never run twice at
// once), and the guard clears however the run ends. Each pass gets its own
// guard, so independent passes never share a fate — one failing or running
// long never skips another (instrumentation.ts).
//
// The guard clears when the run settles; the run's awaits must therefore be
// bounded (their own ceilings, and lib/db.ts's statement and connection
// timeouts for every query), or one hang would disable the pass for the
// process lifetime.
//
// Pure: no server-only import, so the guard is unit-testable.

/** A guarded pass: resolves once the run settles, or at once when skipped. */
export type GuardedPass = (() => Promise<void>) & { readonly label: string }

export function guardedPass(label: string, run: () => Promise<unknown>): GuardedPass {
  let running = false
  const pass = async (): Promise<void> => {
    if (running) {
      console.log(`[${label}] pass skipped — the previous one is still running`)
      return
    }
    running = true
    try {
      await run()
    } finally {
      running = false
    }
  }
  return Object.assign(pass, { label })
}
