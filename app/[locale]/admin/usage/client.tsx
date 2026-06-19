"use client"

// app/[locale]/admin/usage/client.tsx
// Admin usage dashboard — token and tool-call statistics, re-skinned to the
// Alien × BnF DS: a row of stat tiles over the projects and tools tables.
// No initial data prop: the server page only asserts the admin role; the report
// is fetched client-side (not needed for SSR). States are distinct branches.

import { useMemo } from "react"
import { Download } from "lucide-react"
import { useTranslations } from "next-intl"
import { useAdminUsage } from "@/hooks/api/admin"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"
import { CardSharedStat } from "@/components/cards/shared/stat"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

const fr = (n: number) => n.toLocaleString("fr-FR")

export function AdminUsageClient() {
  const t = useTranslations("admin.usage")
  const tCommon = useTranslations("common")
  const { data, isLoading, isError, refetch } = useAdminUsage()

  const totals = useMemo(() => {
    if (!data) return null
    return {
      tokensIn: data.projects.reduce((s, p) => s + p.lastWeekTokens.in, 0),
      tokensOut: data.projects.reduce((s, p) => s + p.lastWeekTokens.out, 0),
      messages: data.projects.reduce((s, p) => s + p.messageCount, 0),
      toolCalls: data.toolFrequency.reduce((s, e) => s + e.count, 0),
    }
  }, [data])

  return (
    <div className="flex min-h-screen flex-col">
      <WorkspaceHeader user={{ email: "admin" }} />
      <main className="mx-auto w-full max-w-5xl px-6 py-12">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div className="space-y-1">
            <span className="mono-eyebrow">{t("eyebrow")}</span>
            <h1 className="text-2xl font-semibold">{t("title")}</h1>
            {data && (
              <p className="text-sm text-muted-foreground">
                {t("lastWeek")} —{" "}
                {new Date(data.since).toLocaleDateString("fr-FR")}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = "/api/admin/usage/export"
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
        ) : data && totals ? (
          <div className="flex flex-col gap-8">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <CardSharedStat label={t("stat.tokensIn")} value={fr(totals.tokensIn)} />
              <CardSharedStat label={t("stat.tokensOut")} value={fr(totals.tokensOut)} />
              <CardSharedStat label={t("stat.messages")} value={fr(totals.messages)} />
              <CardSharedStat label={t("stat.toolCalls")} value={fr(totals.toolCalls)} />
            </div>

            <section className="space-y-3">
              <h2 className="text-base font-semibold">{t("projects")}</h2>
              {data.projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("empty")}</p>
              ) : (
                <Card>
                  <CardContent className="overflow-x-auto px-0">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="px-4 py-2 font-medium">{t("name")}</th>
                          <th className="px-4 py-2 font-medium">{t("owner")}</th>
                          <th className="px-4 py-2 text-right font-medium">{t("tokensIn")}</th>
                          <th className="px-4 py-2 text-right font-medium">{t("tokensOut")}</th>
                          <th className="px-4 py-2 text-right font-medium">{t("messageCount")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.projects.map((p) => (
                          <tr key={p.id} className="border-b last:border-0">
                            <td className="px-4 py-2 font-medium">{p.name}</td>
                            <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                              {p.ownerId}
                            </td>
                            <td className="px-4 py-2 text-right font-mono tabular-nums">
                              {fr(p.lastWeekTokens.in)}
                            </td>
                            <td className="px-4 py-2 text-right font-mono tabular-nums">
                              {fr(p.lastWeekTokens.out)}
                            </td>
                            <td className="px-4 py-2 text-right font-mono tabular-nums">
                              {fr(p.messageCount)}
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
              <h2 className="text-base font-semibold">{t("tools")}</h2>
              {data.toolFrequency.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("empty")}</p>
              ) : (
                <Card>
                  <CardContent className="overflow-x-auto px-0">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="px-4 py-2 font-medium">{t("toolName")}</th>
                          <th className="px-4 py-2 text-right font-medium">{t("count")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.toolFrequency.map((entry) => (
                          <tr key={entry.tool} className="border-b last:border-0">
                            <td className="px-4 py-2 font-mono text-xs">{entry.tool}</td>
                            <td className="px-4 py-2 text-right font-mono tabular-nums">
                              {fr(entry.count)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              )}
            </section>
          </div>
        ) : null}
      </main>
    </div>
  )
}
