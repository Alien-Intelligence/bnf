"use client"

// components/cards/ingest/queue-status.tsx
// Live staged-bucket status for a running ingest — replaces the old four-stage
// pipeline card. Driven by the worker's GET /progress/:runId read-model (proxied
// onto job.queue), it shows what is ACTUALLY happening: the BnF fetch bucket as
// the headline bottleneck (the binding 300/min constraint), the named stage
// groups, and the run totals that ALWAYS reconcile (the anti-V1 rule —
// failed/skipped are never hidden). See playbook/ui-states.md §Ingestion.

import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { INGEST_STATUS } from "@/models/ingest/schema"
import type { IngestJobStatusView } from "@/models/ingest/types"
import type { ClusterQueueStage } from "@/lib/cluster/contracts"

// Worker stage buckets → the named groups the design surfaces. fetch is pulled
// out as the headline bottleneck and is not in this list.
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

/** Compact, locale-neutral ETA from seconds ("< 1 min", "~7 min", "~1 h 12 min"). */
function formatEta(seconds: number | null, computing: string): string {
  if (seconds == null) return computing
  if (seconds < 60) return "< 1 min"
  const totalMin = Math.round(seconds / 60)
  if (totalMin < 60) return `~${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `~${h} h` : `~${h} h ${m} min`
}

interface Props {
  job: IngestJobStatusView
  onCancel: () => void
}

export function CardIngestQueueStatus({ job, onCancel }: Props) {
  const t = useTranslations("ingest.queue")
  const tCancel = useTranslations("ingest.cancel")

  const isTerminal =
    job.status === INGEST_STATUS.DONE ||
    job.status === INGEST_STATUS.PARTIAL ||
    job.status === INGEST_STATUS.FAILED ||
    job.status === INGEST_STATUS.CANCELED

  const queue = job.queue

  // No live read-model (fake mode / worker unreachable / between polls): a slim
  // "processing" card — the reassurance banner above already carries the detail.
  if (!queue) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-5">
          <Loader2 className="size-4 shrink-0 animate-spin text-brand-teal" />
          <span className="text-sm text-muted-foreground">{t("noLiveState")}</span>
          {!isTerminal && (
            <Button
              variant="destructive"
              size="sm"
              className="ml-auto"
              onClick={onCancel}
            >
              {tCancel("button")}
            </Button>
          )}
        </CardContent>
      </Card>
    )
  }

  const num = (k: string): number =>
    typeof queue.docs[k] === "number" ? queue.docs[k]! : 0
  const running =
    num("planned") + num("fetching") + num("ready") + num("processing")
  const finishedPct =
    queue.docsTotal > 0
      ? Math.round((queue.docsFinished / queue.docsTotal) * 100)
      : 0

  const fetch = queue.stages.fetch ?? EMPTY_STAGE
  const foliosInFlight = fetch.queued + fetch.running

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

  const etaText = isTerminal ? null : formatEta(queue.etaSeconds, t("etaComputing"))

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Headline — documents fully registered. */}
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13.5px] font-semibold">{t("finalized")}</span>
            <span className="font-mono text-[13px] font-semibold tabular-nums text-brand-teal">
              {queue.docsFinished} / {queue.docsTotal}
            </span>
          </div>
          <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-secondary">
            <span
              className="block h-full rounded-full bg-brand-teal transition-[width] duration-500"
              style={{ width: `${finishedPct}%` }}
            />
          </span>
        </div>

        {/* Bottleneck — the 300/min BnF fetch gate, the binding constraint. */}
        <div className="rounded-lg border bg-secondary/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              {(fetch.running > 0 || fetch.queued > 0) && (
                <Loader2 className="size-3.5 animate-spin text-brand-teal" />
              )}
              {t("fetchTitle")}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {t("rate", { rate: queue.fetchRatePerMin })}
            </span>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {t("foliosInFlight", { count: foliosInFlight })}
            </span>
            {etaText && (
              <span>
                {t("etaLabel")} :{" "}
                <span className="font-mono text-neutral-200">{etaText}</span>
              </span>
            )}
          </div>
        </div>

        {/* Named stage groups — current activity per lane segment. */}
        <ul className="flex flex-col">
          {GROUPS.map((g) => {
            const s = sumStages(queue.stages, g.stages)
            const active = s.running + s.queued
            return (
              <li
                key={g.key}
                className="flex items-center justify-between gap-2 border-b py-2.5 text-[13px] last:border-b-0"
              >
                <span
                  className={cn(
                    "font-medium",
                    active === 0 && s.failed === 0 && "text-muted-foreground",
                  )}
                >
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
                  {s.failed > 0 && (
                    <span className="text-destructive">
                      {t("failedShort", { count: s.failed })}
                    </span>
                  )}
                  {active === 0 && s.failed === 0 && (
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

        {!isTerminal && (
          <div>
            <Button variant="destructive" size="sm" onClick={onCancel}>
              {tCancel("button")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
