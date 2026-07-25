"use client"

// app/[locale]/admin/feedback/client.tsx
// Admin console — Feedback tab. Every feedback row across every project,
// resolved to what it concerns (note title, session title, or turn excerpt)
// and deep-linked into the app, plus a CSV export. Header/tabs/main wrapper
// come from the admin layout. Loading / error / empty / data are distinct.

import { Download, ExternalLink, LineChart } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useAdminFeedback } from "@/hooks/api/admin"
import { Link } from "@/i18n/navigation"
import { ROUTES } from "@/lib/constants"
import { FEEDBACK_TARGET } from "@/models/feedback/schema"
import type { AdminFeedbackRow } from "@/models/feedback/schema"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

/** Badge tint per rating — brand teal for great, muted for ok, destructive for bad. */
const RATING_CLASS: Record<string, string> = {
  great: "bg-brand-teal/15 text-brand-teal border-brand-teal/30",
  ok: "bg-secondary text-foreground",
  bad: "bg-destructive/10 text-destructive border-destructive/30",
}

/**
 * In-app deep-link for a feedback's target. Notes live in the Carnet; sessions
 * and turns route to their step (corpus → Constituer, research → Rechercher).
 */
function targetHref(row: AdminFeedbackRow): string {
  if (row.target === FEEDBACK_TARGET.NOTE) return ROUTES.carnet(row.projectId)
  if (row.resolved?.sessionScope === "corpus") {
    return ROUTES.constituer(row.projectId)
  }
  return ROUTES.rechercher(row.projectId)
}

export function AdminFeedbackClient() {
  const t = useTranslations("admin.feedback")
  const tRating = useTranslations("admin.rating")
  const tTarget = useTranslations("admin.target")
  const tCommon = useTranslations("common")
  const locale = useLocale()
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, {
      dateStyle: "medium",
    })

  const { data, isLoading, isError, refetch } = useAdminFeedback()
  const feedback = data?.feedback ?? []

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <span className="mono-eyebrow">{t("eyebrow")}</span>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            window.location.href = "/api/admin/feedback/export"
          }}
        >
          <Download className="size-4" />
          {t("exportCsv")}
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : isError ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-destructive">{tCommon("error")}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {tCommon("tryAgain")}
          </Button>
        </div>
      ) : feedback.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Card>
          <CardContent className="flex flex-col divide-y px-0">
            {feedback.map((f) => (
              <article key={f.id} className="flex flex-col gap-2 px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className={cn(RATING_CLASS[f.rating] ?? "")}
                  >
                    {tRating(f.rating)}
                  </Badge>
                  <Badge variant="secondary">{tTarget(f.target)}</Badge>
                  <span className="text-sm font-medium">{f.projectName}</span>
                  <span className="text-xs text-muted-foreground">
                    {f.userName} · {f.userEmail}
                  </span>
                  <div className="ml-auto flex items-center gap-3">
                    {f.langfuseUrl && (
                      <a
                        href={f.langfuseUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <LineChart className="size-3" />
                        {t("langfuse")}
                      </a>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {fmtDate(f.createdAt)}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="shrink-0">{t("col.target")}:</span>
                  {f.resolved ? (
                    <Link
                      href={targetHref(f)}
                      className="inline-flex items-center gap-1 truncate text-foreground hover:underline"
                    >
                      <span className="truncate">
                        {f.resolved.label || tTarget(f.target)}
                      </span>
                      <ExternalLink className="size-3 shrink-0" />
                    </Link>
                  ) : (
                    <span className="italic">{t("deleted")}</span>
                  )}
                </div>

                {f.comment ? (
                  <p className="text-sm whitespace-pre-wrap">{f.comment}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("noComment")}</p>
                )}
              </article>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
