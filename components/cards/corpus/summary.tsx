"use client"

// components/cards/corpus/summary.tsx
// The corpus comprehension summary: four always-visible stat tiles
// (Documents / Période / Types / Langues) mirroring the prototype grid
// (design/BnF Corpus Research.dc.html, summary tiles lines 289-296).
// Client component: receives live corpus state after TanStack Query revalidates.

import { useTranslations } from "next-intl"
import { CardSharedStat } from "@/components/cards/shared/stat"
import type { CorpusSnapshot } from "@/models/corpus/schema"

interface Props {
  corpus: CorpusSnapshot
}

/** Derive "1880s – 1890s" (or a single decade, or null) from period keys. */
function periodRange(period: Record<string, number>): string | null {
  const keys = Object.keys(period)
  if (keys.length === 0) return null
  const sorted = [...keys].sort()
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  return first === last ? first : `${first} – ${last}`
}

/** Distinct language codes, most frequent first, upper-cased for the sub-line. */
function langCodes(lang: Record<string, number>): string[] {
  return Object.entries(lang)
    .sort(([, a], [, b]) => b - a)
    .map(([code]) => code.toUpperCase())
}

export function CardCorpusSummary({ corpus }: Props) {
  const t = useTranslations("corpus.summary")

  const range = periodRange(corpus.facets.period)
  const typeCount = Object.keys(corpus.facets.type).length
  const codes = langCodes(corpus.facets.lang)

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <CardSharedStat
        label={t("documents")}
        value={corpus.total.toLocaleString("fr-FR")}
        sub={
          corpus.pendingCount > 0
            ? t("pendingSub", { count: corpus.pendingCount })
            : t("arkNotices")
        }
      />
      <CardSharedStat
        label={t("period")}
        value={range ?? "—"}
        sub={
          corpus.undatedCount > 0
            ? t("undatedSub", { count: corpus.undatedCount })
            : t("datedSub")
        }
      />
      <CardSharedStat
        label={t("types")}
        value={typeCount}
        sub={t("categories")}
      />
      <CardSharedStat
        label={t("languages")}
        value={codes.length}
        sub={codes.join(" · ") || "—"}
      />
    </div>
  )
}
