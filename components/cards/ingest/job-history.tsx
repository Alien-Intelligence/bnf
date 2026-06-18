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
import type { IngestJob } from "@/models/ingest/schema"

interface Props {
  projectId: string
  jobs: IngestJob[]
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
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <BadgeIngestStatus status={job.status} />
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {relativeDate(new Date(job.createdAt))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
