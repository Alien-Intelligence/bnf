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
import { Progress } from "@/components/ui/progress"
import {
  CheckCircle,
  Circle,
  Loader2,
  Minus,
  XCircle,
} from "lucide-react"
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

function StageIcon({ state }: { state: StageState }) {
  switch (state) {
    case "done":
      return <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-primary" />
    case "failed":
      return <XCircle className="h-4 w-4 text-destructive" />
    case "skipped":
      return <Minus className="h-4 w-4 text-muted-foreground" />
    case "pending":
      return <Circle className="h-4 w-4 text-muted-foreground" />
  }
}

interface Props {
  job: IngestJob
  onCancel: () => void
}

export function CardIngestStagePipeline({ job, onCancel }: Props) {
  const t = useTranslations("ingest")
  const tCancel = useTranslations("ingest.cancel")

  const stageInfos = deriveStageInfos(job)

  const isTerminal =
    job.status === INGEST_STATUS.DONE ||
    job.status === INGEST_STATUS.FAILED ||
    job.status === INGEST_STATUS.CANCELED

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {/* No dedicated i18n key for pipeline title in spec — use stage label context */}
          {t("comeBackLater.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-4">
          {stageInfos.map(({ stage, state, progress }) => (
            <li key={stage} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <StageIcon state={state} />
                <span
                  className={
                    state === "pending" || state === "skipped"
                      ? "text-sm text-muted-foreground"
                      : "text-sm font-medium"
                  }
                >
                  {t(`stages.${stage}` as `stages.${typeof stage}`)}
                </span>
              </div>
              {state === "running" && (
                <div className="mt-1 flex items-center gap-2">
                  <Progress value={progress} className="flex-1" />
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {progress}%
                  </span>
                </div>
              )}
            </li>
          ))}
        </ol>

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
