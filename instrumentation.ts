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
  // Rewrite buffer rows written before the v2 buffer (raw dc:type labels, MARC
  // language codes, no record kind) into the canonical vocabulary, once. The
  // version gate makes every later boot a no-op (`updated=0`), so this never
  // runs periodically. Fire-and-forget — must not block serving.
  const { reclassifyBufferItems } = await import("@/lib/buffer/reclassify")
  void reclassifyBufferItems().catch((err) => {
    console.error("[instrumentation] buffer reclassify failed:", err)
  })

  const {
    RESOLVE_SWEEP_INTERVAL_MS,
    CANONICALIZE_SWEEP_INTERVAL_MS,
    BUFFER_ENRICH_SWEEP_INTERVAL_MS,
  } = await import("@/lib/constants")

  // Background enrichment of bare buffer rows (buffer_add stages ARKs only):
  // a boot resume for rows a restart left pending, then a periodic sweep —
  // the resolver's pattern. Each pass is bounded and each failure counts an
  // attempt, so a genuinely unknown ARK still terminates. Fire-and-forget.
  const { resumePendingBufferEnrich } = await import("@/lib/buffer/enricher")
  void resumePendingBufferEnrich().catch((err) => {
    console.error("[instrumentation] boot buffer-enrich resume failed:", err)
  })
  setInterval(() => {
    void resumePendingBufferEnrich().catch((err) => {
      console.error("[instrumentation] periodic buffer-enrich sweep failed:", err)
    })
  }, BUFFER_ENRICH_SWEEP_INTERVAL_MS)
  setInterval(() => {
    void resumePendingResolves().catch((err) => {
      console.error("[instrumentation] periodic resolver sweep failed:", err)
    })
  }, RESOLVE_SWEEP_INTERVAL_MS)

  // Resume background cb→Gallica canonicalization for any catalogue notices left
  // `pending` by a restart mid-upgrade. Same fire-and-forget contract as the
  // resolver above: `corpus_add` adds notices as-is and marks them pending; the
  // canonicalizer swaps each digitized one for its Gallica doc out-of-band.
  const { resumePendingCanonicalize } = await import(
    "@/lib/documents/canonicalizer"
  )
  void resumePendingCanonicalize().catch((err) => {
    console.error("[instrumentation] boot canonicalize resume failed:", err)
  })

  // Periodic canonicalize sweep — the counterpart to the resolve sweep. A
  // transient data.bnf.fr/SRU outage flips notices to `api_error` (terminal for
  // the auto-loop), but a restart or a notice still `pending` with no further
  // kick is recovered here so canonicalization self-heals.
  setInterval(() => {
    void resumePendingCanonicalize().catch((err) => {
      console.error("[instrumentation] periodic canonicalize sweep failed:", err)
    })
  }, CANONICALIZE_SWEEP_INTERVAL_MS)

  // Ingest lifecycle watchdog (audit findings F18 + F21) — periodically
  // reconciles RUNNING ingest jobs whose worker has stopped reporting and
  // QUEUED jobs that never reached the worker at all, so neither can wedge a
  // project's dedup guard forever. No-op unless CLUSTER_MODE=real (fake mode
  // has no worker to poll). See lib/ingest/watchdog.ts for the full contract.
  const { startIngestWatchdog } = await import("@/lib/ingest/watchdog")
  startIngestWatchdog()
}
