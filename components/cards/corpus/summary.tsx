// components/cards/corpus/summary.tsx
// Four-tile corpus overview card: total, period range, top types, top languages.
// Server component — useTranslations works server-side in next-intl 4.x.

import { getTranslations } from "next-intl/server"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { BadgeDocumentType } from "@/components/badges/documents/type-badge"
import { BadgeDocumentLang } from "@/components/badges/documents/lang-badge"
import type { CorpusSnapshot } from "@/models/corpus/schema"

interface Props {
  corpus: CorpusSnapshot
}

/** Top N entries from a facet map, sorted by count descending. */
function topEntries(
  facet: Record<string, number>,
  n: number,
): Array<{ code: string; count: number }> {
  return Object.entries(facet)
    .sort(([, a], [, b]) => b - a)
    .slice(0, n)
    .map(([code, count]) => ({ code, count }))
}

/** Derive "1880s – 1890s" or null from the period facet keys. */
function periodRange(period: Record<string, number>): string | null {
  const keys = Object.keys(period)
  if (keys.length === 0) return null
  const sorted = [...keys].sort()
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  return first === last ? first : `${first} – ${last}`
}

export async function CardCorpusSummary({ corpus }: Props) {
  const t = await getTranslations("corpus.summary")

  const range = periodRange(corpus.facets.period)
  const topTypes = topEntries(corpus.facets.type, 3)
  const topLangs = topEntries(corpus.facets.lang, 3)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold">
          {t("total", { count: corpus.total })}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-4">
          {/* Period range */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground uppercase tracking-wide">
              {t("period")}
            </span>
            <span className="text-sm font-medium">
              {range ?? <span className="text-muted-foreground">—</span>}
            </span>
          </div>

          {/* Top types */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground uppercase tracking-wide">
              {t("types")}
            </span>
            <div className="flex flex-wrap gap-1">
              {topTypes.length > 0 ? (
                topTypes.map(({ code }) => (
                  <BadgeDocumentType key={code} code={code} />
                ))
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </div>
          </div>

          {/* Top languages */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground uppercase tracking-wide">
              {t("languages")}
            </span>
            <div className="flex flex-wrap gap-1">
              {topLangs.length > 0 ? (
                topLangs.map(({ code }) => (
                  <BadgeDocumentLang key={code} code={code} />
                ))
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
