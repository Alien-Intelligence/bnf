export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  // Validate the boot env FIRST, before serving: required variables, and the
  // BNF_MCP_RATE_* limiter config whenever BNF_MCP_URL is set (lib/env.ts). A
  // misconfigured process refuses to start instead of failing its first turn.
  await import("@/lib/env")
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

  // Vocabulary passes (Track E): Document.lang into canonicalLang's form, and
  // buffer rows written before the v2 buffer (raw dc:type labels, MARC
  // language codes, no record kind) into the canonical vocabulary. Both are
  // idempotent (a finished run costs one cheap query) and bounded (their own
  // time ceilings, and the pool's statement/connection timeouts on every
  // query); they run at boot and then on a schedule, so a run that stopped at
  // its ceiling or failed resumes instead of waiting for the next restart.
  // The two passes are INDEPENDENT: each has its own overlap guard and its own
  // failure, so one failing never skips the other. Fire-and-forget — must not
  // block serving.
  const { reclassifyBufferItems } = await import("@/lib/buffer/reclassify")
  const { canonicalizeDocumentLangs } = await import("@/lib/documents/canonical-lang")
  const { guardedPass } = await import("@/lib/background/guarded-pass")
  const langPass = guardedPass("document-lang", canonicalizeDocumentLangs)
  const reclassifyPass = guardedPass("buffer-reclassify", reclassifyBufferItems)
  const runVocabularyPasses = (when: "boot" | "periodic"): void => {
    for (const pass of [langPass, reclassifyPass]) {
      void pass().catch((err: unknown) => {
        console.error(`[instrumentation] ${when} ${pass.label} pass failed:`, err)
      })
    }
  }
  runVocabularyPasses("boot")

  const {
    RESOLVE_SWEEP_INTERVAL_MS,
    CANONICALIZE_SWEEP_INTERVAL_MS,
    BUFFER_ENRICH_SWEEP_INTERVAL_MS,
    BUFFER_RECLASSIFY_SWEEP_INTERVAL_MS,
  } = await import("@/lib/constants")
  // Every periodic sweep below runs through startPeriodic: unref'd, and at most
  // one per name — a re-run of register() (dev hot-reload) replaces the timer
  // instead of stacking another. The handles are kept by lib/async/periodic.
  const { startPeriodic } = await import("@/lib/async/periodic")

  startPeriodic("vocabulary-passes", BUFFER_RECLASSIFY_SWEEP_INTERVAL_MS, async () =>
    runVocabularyPasses("periodic"),
  )

  // Background enrichment of bare buffer rows (buffer_add stages ARKs only):
  // a boot resume for rows a restart left pending, then a periodic sweep —
  // the resolver's pattern. Each drain has a wall-clock ceiling under the
  // sweep interval, each failure counts an attempt and backs off, and the
  // sweep skips a tick while the previous one still runs. Fire-and-forget.
  const { resumePendingBufferEnrich } = await import("@/lib/buffer/enricher")
  void resumePendingBufferEnrich().catch((err) => {
    console.error("[instrumentation] boot buffer-enrich resume failed:", err)
  })
  startPeriodic("buffer-enrich-sweep", BUFFER_ENRICH_SWEEP_INTERVAL_MS, resumePendingBufferEnrich)

  // Periodic resolve sweep. `corpus_add` kicks a drain and the boot resume above
  // runs once, but a transient BnF outage (e.g. a 429 burst on catalogue.bnf.fr)
  // strands rows in `pending` with no further trigger — they would otherwise
  // never recover without a new add or a restart. This sweep re-drains any
  // project with pending stubs so resolution self-heals. Unlike the turn reaper
  // (which must NOT run periodically — live streaming turns are legitimate),
  // pending stubs are never "in flight", so a periodic sweep is safe.
  startPeriodic("resolver-sweep", RESOLVE_SWEEP_INTERVAL_MS, resumePendingResolves)

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
  startPeriodic("canonicalize-sweep", CANONICALIZE_SWEEP_INTERVAL_MS, resumePendingCanonicalize)

  // OCR-quality sync (feedback 2026-09-29 #7): boot resume + periodic sweep that
  // pulls the worker's per-ARK OCR-quality artifacts into DocumentOcr /
  // DocumentFolio, and through it drives the backfill of documents indexed
  // before the feature. An ingest commit persists resync requests for its ARKs
  // and triggers a drain. The timer is unref'd and kept by the module, which
  // replaces it on a re-run of register(). No-op (one log line) unless
  // CLUSTER_MODE=real. See lib/documents/ocr-sync.ts.
  const { startOcrSync } = await import("@/lib/documents/ocr-sync")
  startOcrSync()

  // Ingest lifecycle watchdog (audit findings F18 + F21) — periodically
  // reconciles RUNNING ingest jobs whose worker has stopped reporting and
  // QUEUED jobs that never reached the worker at all, so neither can wedge a
  // project's dedup guard forever. No-op unless CLUSTER_MODE=real (fake mode
  // has no worker to poll). See lib/ingest/watchdog.ts for the full contract.
  const { startIngestWatchdog } = await import("@/lib/ingest/watchdog")
  startIngestWatchdog()
}
