"use client"

// components/cards/ingest/job-history.tsx
// Shows a list of recent IngestJobs for the project. Each row: status badge,
// relative date, and a future link placeholder (job detail view is not in
// scope for this slice). Handles loading/error/empty per ui-states rules.

import { useTranslations } from "next-intl"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { BadgeIngestStatus } from "@/components/badges/ingest/status"
import { INGEST_STATUS } from "@/models/ingest/schema"
import type { IngestJobView } from "@/models/ingest/types"

interface Props {
  projectId: string
  jobs: IngestJobView[]
}

/** Format a Date as a relative string (e.g. "2 days ago") if the Intl
 * RelativeTimeFormat API is available; otherwise falls back to locale date. */
function relativeDate(date: Date): string {
  const diffMs = date.getTime() - Date.now()
  const diffSec = Math.round(diffMs / 1_000)
  const abs = Math.abs(diffSec)

  if (abs < 60) return "à l'instant"

  const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" })

  if (abs < 3_600)
    return rtf.format(Math.round(diffSec / 60), "minute")
  if (abs < 86_400)
    return rtf.format(Math.round(diffSec / 3_600), "hour")
  if (abs < 30 * 86_400)
    return rtf.format(Math.round(diffSec / 86_400), "day")
  return date.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

/** Total run time of a job (finishedAt − startedAt), compact French units. */
function formatDuration(
  startedAt: Date | string | null,
  finishedAt: Date | string | null,
): string | null {
  if (!startedAt || !finishedAt) return null
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const s = Math.round(ms / 1_000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m} min ${rs} s` : `${m} min`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h} h ${rm} min` : `${h} h`
}

/** "v10 → v15", or "v15" on a first ingest with no base version. */
function versionLabel(job: IngestJobView): string | null {
  if (job.targetVersionSeq == null) return null
  return job.baseVersionSeq != null
    ? `v${job.baseVersionSeq} → v${job.targetVersionSeq}`
    : `v${job.targetVersionSeq}`
}

export function CardIngestJobHistory({ jobs }: Props) {
  const t = useTranslations("ingest.history")

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {jobs.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t("empty")}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="flex items-start justify-between gap-3 py-2.5"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    {versionLabel(job) ? (
                      <span className="text-sm font-medium tabular-nums">
                        {versionLabel(job)}
                      </span>
                    ) : null}
                    <BadgeIngestStatus status={job.status} />
                  </div>
                  {(job.status === INGEST_STATUS.PARTIAL ||
                    job.status === INGEST_STATUS.FAILED) &&
                  job.error ? (
                    <span className="text-xs text-muted-foreground">
                      {job.error}
                    </span>
                  ) : null}
                </div>
                <div className="ml-auto flex shrink-0 flex-col items-end gap-0.5 text-xs tabular-nums text-muted-foreground">
                  <span>{relativeDate(new Date(job.createdAt))}</span>
                  {formatDuration(job.startedAt, job.finishedAt) ? (
                    <span>{t("ranFor", { duration: formatDuration(job.startedAt, job.finishedAt) as string })}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
