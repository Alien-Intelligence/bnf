"use client"

// components/cards/ingest/queue-detail.tsx
// The raw worker queue read-model, rendered as the operator/debug view tucked
// under the panel's in-progress "Détails" accordion (CardIngestPanel). It
// preserves the live staged-bucket telemetry the de-geekified headline hides:
// the BnF fetch bottleneck (the binding 300/min constraint), the named stage
// groups, and the run totals that ALWAYS reconcile (the anti-V1 rule —
// failed/skipped are never hidden). No Card chrome, no cancel, no progress bar —
// the parent panel owns all of those; this is the detail only.

import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type {
  ClusterQueueProgress,
  ClusterQueueStage,
} from "@/lib/cluster/contracts"

// Worker stage buckets → the named groups. fetch is pulled out as the headline
// bottleneck and is not in this list.
const GROUPS = [
  { key: "metadata", stages: ["metadata", "manifest"] },
  { key: "images", stages: ["describe"] },
  { key: "prep", stages: ["assemble", "embed"] },
  { key: "ocr", stages: ["ocrSubmit", "ocrPoll"] },
  { key: "index", stages: ["register"] },
] as const

const EMPTY_STAGE: ClusterQueueStage = { done: 0, running: 0, queued: 0, failed: 0 }

function sumStages(
  stages: Record<string, ClusterQueueStage>,
  keys: readonly string[],
): ClusterQueueStage {
  return keys.reduce<ClusterQueueStage>(
    (acc, k) => {
      const s = stages[k]
      if (!s) return acc
      return {
        done: acc.done + s.done,
        running: acc.running + s.running,
        queued: acc.queued + s.queued,
        failed: acc.failed + s.failed,
      }
    },
    { ...EMPTY_STAGE },
  )
}

export function IngestQueueDetail({ queue }: { queue: ClusterQueueProgress }) {
  const t = useTranslations("ingest.queue")

  const num = (k: string): number =>
    typeof queue.docs[k] === "number" ? queue.docs[k]! : 0
  const running =
    num("planned") + num("fetching") + num("ready") + num("processing")

  const fetch = queue.stages.fetch ?? EMPTY_STAGE
  const folios = queue.folios
  const foliosRemaining = Math.max(0, folios.expected - folios.done - folios.failed)
  const foliosAhead = queue.foliosAhead ?? 0

  // Run totals — always reconcile to docsTotal (done + running + queued + failed
  // + skipped). Surfaced verbatim so the view can never hide failures/skips.
  const totals: { key: string; value: number; tone: string }[] = [
    { key: "done", value: num("done"), tone: "text-brand-teal" },
    { key: "running", value: running, tone: "text-foreground" },
    { key: "queued", value: num("queued"), tone: "text-muted-foreground" },
    { key: "failed", value: num("failed"), tone: "text-destructive" },
    {
      key: "skipped",
      value: num("skipped") + num("excluded"),
      tone: "text-muted-foreground",
    },
  ]

  return (
    <div className="space-y-4">
      {/* Bottleneck — the BnF fetch gate, the binding constraint. */}
      <div className="rounded-lg border bg-secondary/30 p-3">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-2 text-[13px] font-semibold">
            {(fetch.running > 0 || fetch.queued > 0) && (
              <Loader2 className="size-3.5 animate-spin text-brand-teal" />
            )}
            {t("fetchTitle")}
          </span>
        </div>
        <div className="mt-1.5 text-xs">
          <span className="tabular-nums text-foreground">
            {t("foliosFetched", { done: folios.done, total: folios.expected })}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3 font-mono text-[11px] tabular-nums text-muted-foreground">
          {fetch.running > 0 && (
            <span className="text-brand-teal">
              {t("inProgress", { count: fetch.running })}
            </span>
          )}
          <span>{t("waiting", { count: foliosRemaining })}</span>
          {foliosAhead > 0 && (
            <span className="text-amber-500/80">
              {t("ahead", { count: foliosAhead })}
            </span>
          )}
        </div>
      </div>

      {/* Named stage groups — current activity per lane segment. */}
      <ul className="flex flex-col">
        {GROUPS.map((g) => {
          const s = sumStages(queue.stages, g.stages)
          // ONLY running/queued — these are current pg-boss state. done/failed
          // accumulate across ALL runs (shared buckets), so showing them would
          // inherit stale counts and contradict the reconciling run totals.
          const active = s.running + s.queued
          return (
            <li
              key={g.key}
              className="flex items-center justify-between gap-2 border-b py-2.5 text-[13px] last:border-b-0"
            >
              <span className={cn("font-medium", active === 0 && "text-muted-foreground")}>
                {t(`groups.${g.key}` as "groups.metadata")}
              </span>
              <span className="flex items-center gap-3 font-mono text-[11px] tabular-nums">
                {s.running > 0 && (
                  <span className="text-brand-teal">
                    {t("inProgress", { count: s.running })}
                  </span>
                )}
                {s.queued > 0 && (
                  <span className="text-muted-foreground">
                    {t("waiting", { count: s.queued })}
                  </span>
                )}
                {active === 0 && (
                  <span className="text-muted-foreground">{t("idle")}</span>
                )}
              </span>
            </li>
          )
        })}
      </ul>

      {/* Run totals — the reconciling counters (never hide failed/skipped). */}
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-[11px] tabular-nums">
        {totals.map((o) => (
          <li key={o.key} className="flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full bg-current", o.tone)} />
            <span className={o.tone}>
              {t(`totals.${o.key}` as "totals.done", { count: o.value })}
            </span>
          </li>
        ))}
        {!queue.reconciles && (
          <li className="text-amber-500">{t("reconcileWarning")}</li>
        )}
      </ul>
    </div>
  )
}
