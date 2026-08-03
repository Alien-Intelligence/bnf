// lib/ingest/stage-narrative.ts
// Maps the worker's raw queue read-model onto the five librarian-facing phases
// the Ingérer panel narrates ("Récupération des pages à la BnF…"), plus a
// compact ETA. The panel shows ONE phase + one bar; the raw per-bucket telemetry
// stays available under the panel's in-progress "Détails" accordion (see
// components/cards/ingest/queue-detail.tsx). Pure — no React, no i18n.

import type { ClusterQueueProgress } from "@/lib/cluster/contracts"

/**
 * The five phases a librarian sees, in pipeline order. Each maps to an i18n key
 * under `ingest.panel.phases.<key>`. Kept as a const tuple so the panel can
 * index it by {@link currentPhaseIndex} and render "Phase N sur 5".
 */
export const INGEST_PHASE_KEYS = [
  "notices",
  "fetch",
  "describe",
  "prepare",
  "index",
] as const
export type IngestPhaseKey = (typeof INGEST_PHASE_KEYS)[number]

// Worker stage buckets grouped under each librarian phase. Same grouping the
// detail view uses, with the binding BnF fetch bucket owning its own phase (it
// is the headline bottleneck). Keys that never appear in `queue.stages` are
// simply ignored, so this tolerates worker-side stage renames gracefully.
const PHASE_STAGES: readonly (readonly string[])[] = [
  ["metadata", "manifest"],
  ["fetch"],
  ["describe"],
  ["assemble", "embed", "ocrSubmit", "ocrPoll"],
  ["register"],
]

/**
 * The phase to narrate as "happening now": the earliest phase that still has
 * running or queued work — the front of the pipeline, where documents are
 * currently held. When nothing is left in flight the run is finishing, so we
 * report the final phase (indexation). Returns an index into
 * {@link INGEST_PHASE_KEYS}.
 */
export function currentPhaseIndex(queue: ClusterQueueProgress): number {
  for (let i = 0; i < PHASE_STAGES.length; i++) {
    const active = PHASE_STAGES[i].reduce((sum, key) => {
      const s = queue.stages[key]
      return s ? sum + s.running + s.queued : sum
    }, 0)
    if (active > 0) return i
  }
  return PHASE_STAGES.length - 1
}

/**
 * Compact ETA for the panel headline ("≈ 7 min", "≈ 1 h 10", "< 1 min"), or
 * null when the worker has not yet computed one (the panel then shows an
 * "estimation en cours…" placeholder instead).
 */
export function formatEtaCompact(seconds: number | null): string | null {
  if (seconds == null) return null
  if (seconds < 60) return "< 1 min"
  const totalMin = Math.round(seconds / 60)
  if (totalMin < 60) return `≈ ${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `≈ ${h} h` : `≈ ${h} h ${String(m).padStart(2, "0")}`
}
