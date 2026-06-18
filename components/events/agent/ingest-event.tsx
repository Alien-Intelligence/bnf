// components/events/agent/ingest-event.tsx
// Renders a single ingestion domain event row inside the chat panel.
// When a jobId is present, polls live status and renders a deep-link to
// the Ingérer page so the librarian can track progress after navigation.
// Client component — uses translations and TanStack Query.

"use client"

import Link from "next/link"
import { Cog, ArrowRight } from "lucide-react"
import { useTranslations } from "next-intl"
import { useIngestStatus } from "@/hooks/api/ingest"

interface Props {
  status: string
  jobId?: string | null
  /** e.g. "/fr/projects/<id>/ingerer" — built by the chat layout from locale + projectId */
  projectLocaleHref?: string
}

export function EventIngestRow({ status, jobId, projectLocaleHref }: Props) {
  const t = useTranslations("corpus.events")
  const live = useIngestStatus(jobId ?? null)
  const renderedStatus = live.data?.status ?? status

  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
      <Cog className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{t("ingestSubmitted", { status: renderedStatus })}</span>
      {jobId != null && projectLocaleHref != null && (
        <Link
          href={`${projectLocaleHref}?job=${jobId}`}
          className="inline-flex items-center gap-0.5 underline underline-offset-2"
        >
          {t("openIngest")}
          <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
        </Link>
      )}
    </div>
  )
}
