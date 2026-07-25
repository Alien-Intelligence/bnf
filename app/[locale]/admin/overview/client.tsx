"use client"

// app/[locale]/admin/overview/client.tsx
// Admin console — Overview tab. Headline platform totals as stat tiles, the
// 30-day sign-up trend, and the feedback distribution (by rating and by
// target). Header/tabs/main wrapper come from the admin layout; this renders
// only the tab's own content. Loading / error / data are distinct branches.

import { useLocale, useTranslations } from "next-intl"
import { useAdminOverview } from "@/hooks/api/admin"
import { CardSharedStat } from "@/components/cards/shared/stat"
import { ChartAdminSignupsTrend } from "@/components/charts/admin/signups-trend"
import { ChartAdminDistributionBars } from "@/components/charts/admin/distribution-bars"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

export function AdminOverviewClient() {
  const t = useTranslations("admin.overview")
  const tRating = useTranslations("admin.rating")
  const tTarget = useTranslations("admin.target")
  const tCommon = useTranslations("common")
  const locale = useLocale()
  const fmt = (n: number) => n.toLocaleString(locale)

  const { data, isLoading, isError, refetch } = useAdminOverview()

  return (
    <div className="flex flex-col gap-8">
      <div className="space-y-1">
        <span className="mono-eyebrow">{t("eyebrow")}</span>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-8">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
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
            <CardSharedStat
              label={t("stat.users")}
              value={fmt(data.totals.users)}
            />
            <CardSharedStat
              label={t("stat.newUsers")}
              value={fmt(data.newUsersLast30d)}
              accent
            />
            <CardSharedStat
              label={t("stat.projects")}
              value={fmt(data.totals.projects)}
            />
            <CardSharedStat
              label={t("stat.sessions")}
              value={fmt(data.totals.sessions)}
            />
            <CardSharedStat
              label={t("stat.messages")}
              value={fmt(data.totals.messages)}
            />
            <CardSharedStat
              label={t("stat.notes")}
              value={fmt(data.totals.notes)}
            />
            <CardSharedStat
              label={t("stat.feedback")}
              value={fmt(data.totals.feedback)}
            />
            <CardSharedStat
              label={t("stat.tokensIn")}
              value={fmt(data.totals.tokensIn)}
              sub={`${t("stat.tokensOut")}: ${fmt(data.totals.tokensOut)}`}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("signups")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartAdminSignupsTrend
                data={data.signupsByDay}
                locale={locale}
              />
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t("feedbackByRating")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.feedbackByRating.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("empty")}</p>
                ) : (
                  <ChartAdminDistributionBars
                    locale={locale}
                    items={data.feedbackByRating.map((b) => ({
                      label: tRating(b.key),
                      value: b.count,
                    }))}
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t("feedbackByTarget")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.feedbackByTarget.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("empty")}</p>
                ) : (
                  <ChartAdminDistributionBars
                    locale={locale}
                    items={data.feedbackByTarget.map((b) => ({
                      label: tTarget(b.key),
                      value: b.count,
                    }))}
                  />
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  )
}
