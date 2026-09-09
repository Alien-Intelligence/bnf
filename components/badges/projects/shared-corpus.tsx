"use client"

// components/badges/projects/shared-corpus.tsx
// BadgeSharedCorpus — marks a project that reads another project's corpus.
// Short by design: the source's NAME belongs on the tile's meta line, beside
// the owner, where it has room to be read. A badge carrying a full project
// title overflows a 400px card.
//
// The revoked state gets its own, visually distinct badge: a withdrawn grant is
// not "a shared corpus", it is a workspace that can no longer reach one.

import { useTranslations } from "next-intl"
import { Link2, Link2Off } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { CORPUS_SOURCE_STATE } from "@/lib/authz/corpus-source"
import type { CorpusSourceState } from "@/lib/authz/corpus-source"

interface BadgeSharedCorpusProps {
  state: CorpusSourceState
}

export function BadgeSharedCorpus({ state }: BadgeSharedCorpusProps) {
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
      {t("short")}
    </Badge>
  )
}
