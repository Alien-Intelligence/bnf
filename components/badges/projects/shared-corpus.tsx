"use client"

// components/badges/projects/shared-corpus.tsx
// BadgeSharedCorpus — marks a derived project: a workspace whose corpus belongs
// to another project. Renders the revoked state distinctly, because a revoked
// grant is not "an empty corpus" but "a corpus you can no longer reach".

import { useTranslations } from "next-intl"
import { Link2, Link2Off } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { CORPUS_SOURCE_STATE } from "@/lib/authz/corpus-source"
import type { CorpusSourceState } from "@/lib/authz/corpus-source"

interface BadgeSharedCorpusProps {
  state: CorpusSourceState
  sourceName: string
}

export function BadgeSharedCorpus({
  state,
  sourceName,
}: BadgeSharedCorpusProps) {
  const t = useTranslations("projects.sharedCorpus")

  if (state === CORPUS_SOURCE_STATE.OWN) return null

  if (state === CORPUS_SOURCE_STATE.REVOKED) {
    return (
      <Badge variant="destructive">
        <Link2Off className="size-3" strokeWidth={1.8} />
        {t("revoked")}
      </Badge>
    )
  }

  return (
    <Badge variant="outline">
      <Link2 className="size-3" strokeWidth={1.8} />
      {t("label", { source: sourceName })}
    </Badge>
  )
}
