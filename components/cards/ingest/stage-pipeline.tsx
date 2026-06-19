"use client"

// components/cards/ingest/stage-pipeline.tsx
// Four-row pipeline card showing the four ingest stages (extract / chunk /
// embed / index). Each row is always rendered — no loading/empty state —
// because the pipeline always exists once a job exists. Stage state is
// derived from job.stage + job.status, never from poll-based guessing.
// See playbook/ui-states.md §Ingestion.

import { useTranslations } from "next-intl"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Check, Loader2, Minus, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { INGEST_STATUS, INGEST_STAGE } from "@/models/ingest/schema"
import type { IngestJob } from "@/models/ingest/schema"

// The canonical stage order. The index determines the ordinal comparison.
const STAGE_ORDER = [
  INGEST_STAGE.EXTRACT,
  INGEST_STAGE.CHUNK,
  INGEST_STAGE.EMBED,
  INGEST_STAGE.INDEX,
] as const

type StageState = "pending" | "running" | "done" | "failed" | "skipped"

interface StageInfo {
  stage: string
  state: StageState
  /** 0–100 progress percentage, only meaningful when state === "running" */
  progress: number
}

/**
 * Derive the display state for every stage from the job's current stage
 * and status. This is a pure function — deterministic, no side-effects.
 */
function deriveStageInfos(job: IngestJob): StageInfo[] {
  const currentStageIndex = job.stage
    ? STAGE_ORDER.indexOf(job.stage as (typeof STAGE_ORDER)[number])
    : -1

  // Clamp job.progress (Decimal from Prisma) to a 0–100 integer.
  const jobProgress = Math.max(
    0,
    Math.min(100, Math.round(Number(job.progress ?? 0))),
  )

  return STAGE_ORDER.map((stage, idx) => {
    if (job.status === INGEST_STATUS.DONE) {
      return { stage, state: "done", progress: 100 }
    }

    if (job.status === INGEST_STATUS.FAILED) {
      if (idx < currentStageIndex) return { stage, state: "done", progress: 100 }
      if (idx === currentStageIndex) return { stage, state: "failed", progress: 0 }
      return { stage, state: "skipped", progress: 0 }
    }

    if (job.status === INGEST_STATUS.CANCELED) {
      if (idx < currentStageIndex) return { stage, state: "done", progress: 100 }
      return { stage, state: "skipped", progress: 0 }
    }

    // Running or queued
    if (idx < currentStageIndex) return { stage, state: "done", progress: 100 }
    if (idx === currentStageIndex) {
      return { stage, state: "running", progress: jobProgress }
    }
    return { stage, state: "pending", progress: 0 }
  })
}

/** The circular stage indicator: teal check (done), teal spinner (running),
 *  destructive cross (failed), dash (skipped), or the 1-based ordinal. */
function StageBadge({ state, ordinal }: { state: StageState; ordinal: number }) {
  const base =
    "flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium"
  switch (state) {
    case "done":
      return (
        <span className={cn(base, "bg-brand-teal/20 text-brand-teal")}>
          <Check className="size-4" strokeWidth={2.5} />
        </span>
      )
    case "running":
      return (
        <span className={cn(base, "bg-brand-teal/20 text-brand-teal")}>
          <Loader2 className="size-4 animate-spin" strokeWidth={2.4} />
        </span>
      )
    case "failed":
      return (
        <span className={cn(base, "bg-destructive/15 text-destructive")}>
          <X className="size-4" strokeWidth={2.5} />
        </span>
      )
    case "skipped":
      return (
        <span className={cn(base, "bg-secondary text-muted-foreground")}>
          <Minus className="size-4" />
        </span>
      )
    case "pending":
      return (
        <span className={cn(base, "border bg-card font-mono text-muted-foreground")}>
          {ordinal}
        </span>
      )
  }
}

interface Props {
  job: IngestJob
  onCancel: () => void
}

export function CardIngestStagePipeline({ job, onCancel }: Props) {
  const tStages = useTranslations("ingest.stages")
  const tDesc = useTranslations("ingest.stageDesc")
  const tStatus = useTranslations("ingest.status")
  const tPipeline = useTranslations("ingest.pipeline")
  const tCancel = useTranslations("ingest.cancel")

  const stageInfos = deriveStageInfos(job)

  const isTerminal =
    job.status === INGEST_STATUS.DONE ||
    job.status === INGEST_STATUS.FAILED ||
    job.status === INGEST_STATUS.CANCELED

  // Overall progress: each completed stage contributes its full quarter; the
  // running stage contributes its fraction. Deterministic, no poll guessing.
  const overall = Math.round(
    stageInfos.reduce(
      (sum, s) => sum + (s.state === "done" ? 100 : s.state === "running" ? s.progress : 0),
      0,
    ) / stageInfos.length,
  )

  function statusLabel(state: StageState, progress: number): string {
    switch (state) {
      case "done":
        return tStatus("done")
      case "running":
        return `${progress}%`
      case "failed":
        return tStatus("failed")
      case "skipped":
        return tPipeline("skipped")
      case "pending":
        return tPipeline("pending")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tPipeline("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col">
          {stageInfos.map(({ stage, state, progress }, idx) => (
            <li
              key={stage}
              className="flex gap-3.5 border-b py-4 last:border-b-0"
            >
              <StageBadge state={state} ordinal={idx + 1} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "text-[13.5px] font-semibold",
                      (state === "pending" || state === "skipped") &&
                        "text-muted-foreground",
                    )}
                  >
                    {tStages(stage as "extract")}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {statusLabel(state, progress)}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {tDesc(stage as "extract")}
                </p>
                <span className="mt-2 block h-1.25 overflow-hidden rounded-full bg-secondary">
                  <span
                    className={cn(
                      "block h-full rounded-full transition-[width] duration-500",
                      state === "failed" ? "bg-destructive" : "bg-brand-teal",
                    )}
                    style={{
                      width: `${state === "done" ? 100 : state === "running" ? progress : 0}%`,
                    }}
                  />
                </span>
              </div>
            </li>
          ))}
        </ol>

        <div className="flex items-center justify-between border-t pt-4">
          <span className="text-xs text-muted-foreground">
            {tPipeline("target")} :{" "}
            <span className="font-mono text-neutral-200">
              {tPipeline("targetValue")}
            </span>
          </span>
          <span className="font-mono text-[13px] font-semibold text-brand-teal">
            {overall}%
          </span>
        </div>

        {!isTerminal && (
          <div className="mt-4">
            <Button variant="destructive" size="sm" onClick={onCancel}>
              {tCancel("button")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
