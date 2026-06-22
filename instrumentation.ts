export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  // Defer the import so this file doesn't pull node-only modules into edge runtimes.
  // Boot-time crash recovery: a process restart leaves no in-memory turns, so
  // any Message still marked "streaming" is orphaned — sweep it to error once
  // here, before serving. The live turn lifecycle is owned by the SDK runtime.
  const { runReaperCycle } = await import("@/lib/agent/runtime/reaper")
  await runReaperCycle().catch((err) => {
    console.error("[instrumentation] boot reaper sweep failed:", err)
  })

  // Resume background metadata resolution for any document stubs left pending by
  // a restart mid-resolution. Fire-and-forget — must not block serving.
  const { resumePendingResolves } = await import("@/lib/documents/resolver")
  void resumePendingResolves().catch((err) => {
    console.error("[instrumentation] boot resolver resume failed:", err)
  })

  // Periodic resolve sweep. `corpus_add` kicks a drain and the boot resume above
  // runs once, but a transient BnF outage (e.g. a 429 burst on catalogue.bnf.fr)
  // strands rows in `pending` with no further trigger — they would otherwise
  // never recover without a new add or a restart. This sweep re-drains any
  // project with pending stubs so resolution self-heals. Unlike the turn reaper
  // (which must NOT run periodically — live streaming turns are legitimate),
  // pending stubs are never "in flight", so a periodic sweep is safe.
  const { RESOLVE_SWEEP_INTERVAL_MS } = await import("@/lib/constants")
  setInterval(() => {
    void resumePendingResolves().catch((err) => {
      console.error("[instrumentation] periodic resolver sweep failed:", err)
    })
  }, RESOLVE_SWEEP_INTERVAL_MS)
}
