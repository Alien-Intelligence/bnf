// components/events/agent/ingest-event.tsx
// Renders a single ingestion domain event row inside the chat panel.
// Slice 4 will extend this with a live job-id link; for now it shows the
// status string and an optional job identifier.
// Client component — uses translations.

"use client"

import { Cog } from "lucide-react"
import { useTranslations } from "next-intl"

interface Props {
  status: string
  jobId?: string
}

export function EventIngestRow({ status, jobId }: Props) {
  const t = useTranslations("corpus.events")

  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
      <Cog className="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        {t("ingestStub")}
        {jobId != null && (
          <span className="ml-1 font-mono opacity-60">#{jobId}</span>
        )}
        {status && status !== "not-implemented" && (
          <span className="ml-1 opacity-60">· {status}</span>
        )}
      </span>
    </div>
  )
}
