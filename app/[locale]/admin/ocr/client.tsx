"use client"

// app/[locale]/admin/ocr/client.tsx
// Admin console — OCR tab. Paid-OCR (Mistral) spend + ingest volume: headline
// tiles, per-project spend vs budget, and recent paid ingests. Only paid OCR
// carries a tracked cost; the vision/embed steps are intentionally absent (see
// the subtitle). Header/tabs/main wrapper come from the admin layout.

import { Download } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useAdminOcr } from "@/hooks/api/admin"
import { CardSharedStat } from "@/components/cards/shared/stat"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

/** Badge tint per ingest status. */
const STATUS_CLASS: Record<string, string> = {
  done: "bg-brand-teal/15 text-brand-teal border-brand-teal/30",
  partial: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  failed: "bg-destructive/10 text-destructive border-destructive/30",
  canceled: "bg-secondary text-muted-foreground",
}

export function AdminOcrClient() {
  const t = useTranslations("admin.ocr")
  const tCommon = useTranslations("common")
  const locale = useLocale()
  const fmt = (n: number) => n.toLocaleString(locale)
  const usd = (n: number) =>
    n.toLocaleString(locale, { style: "currency", currency: "USD" })
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { dateStyle: "medium" })

  const { data, isLoading, isError, refetch } = useAdminOcr()

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-end justify-between gap-4">
        <div className="max-w-2xl space-y-1">
          <span className="mono-eyebrow">{t("eyebrow")}</span>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            window.location.href = "/api/admin/ocr/export"
          }}
        >
          <Download className="size-4" />
          {t("exportCsv")}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-8">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-48 rounded-xl" />
        </div>
      ) : isError ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-destructive">{tCommon("error")}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {tCommon("tryAgain")}
          </Button>
        </div>
      ) : data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <CardSharedStat label={t("stat.spend")} value={usd(data.totals.spentUsd)} accent />
            <CardSharedStat label={t("stat.pages")} value={fmt(data.totals.pagesApprox)} />
            <CardSharedStat label={t("stat.docs")} value={fmt(data.totals.paidOcrDocs)} />
            <CardSharedStat label={t("stat.jobs")} value={fmt(data.totals.paidJobs)} />
          </div>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">{t("projects")}</h2>
            {data.projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("emptyProjects")}</p>
            ) : (
              <Card>
                <CardContent className="overflow-x-auto px-0">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="px-4 py-2 font-medium">{t("col.project")}</th>
                        <th className="px-4 py-2 font-medium">{t("col.owner")}</th>
                        <th className="px-4 py-2 text-right font-medium">{t("col.spent")}</th>
                        <th className="px-4 py-2 text-right font-medium">{t("col.budget")}</th>
                        <th className="px-4 py-2 text-right font-medium">{t("col.jobs")}</th>
                        <th className="px-4 py-2 text-right font-medium">{t("col.docs")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.projects.map((p) => (
                        <tr key={p.projectId} className="border-b last:border-0">
                          <td className="px-4 py-2 font-medium">{p.projectName}</td>
                          <td className="px-4 py-2 text-xs text-muted-foreground">
                            {p.ownerEmail}
                          </td>
                          <td className="px-4 py-2 text-right font-mono tabular-nums">
                            {usd(p.spentUsd)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono tabular-nums text-muted-foreground">
                            {p.budgetUsd === null ? t("noBudget") : usd(p.budgetUsd)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono tabular-nums">
                            {fmt(p.paidJobCount)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono tabular-nums">
                            {fmt(p.paidOcrDocs)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">{t("recentJobs")}</h2>
            {data.recentJobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("emptyJobs")}</p>
            ) : (
              <Card>
                <CardContent className="overflow-x-auto px-0">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="px-4 py-2 font-medium">{t("col.project")}</th>
                        <th className="px-4 py-2 font-medium">{t("col.status")}</th>
                        <th className="px-4 py-2 text-right font-medium">{t("col.docs")}</th>
                        <th className="px-4 py-2 text-right font-medium">{t("col.estimated")}</th>
                        <th className="px-4 py-2 text-right font-medium">{t("col.actual")}</th>
                        <th className="px-4 py-2 text-right font-medium">{t("col.chunks")}</th>
                        <th className="px-4 py-2 font-medium">{t("col.date")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentJobs.map((j) => (
                        <tr key={j.id} className="border-b last:border-0">
                          <td className="px-4 py-2 font-medium">{j.projectName}</td>
                          <td className="px-4 py-2">
                            <Badge
                              variant="outline"
                              className={cn(STATUS_CLASS[j.status] ?? "")}
                            >
                              {j.status}
                            </Badge>
                          </td>
                          <td className="px-4 py-2 text-right font-mono tabular-nums">
                            {fmt(j.paidOcrDocs)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono tabular-nums text-muted-foreground">
                            {j.estimatedUsd === null ? "—" : usd(j.estimatedUsd)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono tabular-nums">
                            {j.actualUsd === null ? "—" : usd(j.actualUsd)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono tabular-nums text-muted-foreground">
                            {j.chunksWritten === null ? "—" : fmt(j.chunksWritten)}
                          </td>
                          <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                            {fmtDate(j.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            )}
          </section>
        </>
      ) : null}
    </div>
  )
}
