"use client"

// app/[locale]/admin/usage/client.tsx
// Admin usage dashboard — token and tool-call statistics.
// No initial data prop: the server page only asserts the admin role;
// data is fetched client-side because this report is not needed for SSR.

import { useTranslations } from "next-intl"
import { useAdminUsage } from "@/hooks/api/admin"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"

export function AdminUsageClient() {
  const t = useTranslations("admin.usage")
  const tCommon = useTranslations("common")
  const { data, isLoading, isError, refetch } = useAdminUsage()

  return (
    <div className="flex min-h-screen flex-col">
      <WorkspaceHeader user={{ email: "admin" }} />
      <div className="mx-auto w-full max-w-5xl px-6 py-12">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <button
            type="button"
            onClick={() => { window.location.href = "/api/admin/usage/export" }}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted transition-colors"
          >
            {t("exportCsv")}
          </button>
        </div>

        {isLoading && (
          <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
        )}

        {isError && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-destructive">{tCommon("error")}</p>
            <button
              type="button"
              onClick={() => refetch()}
              className="w-fit rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted transition-colors"
            >
              {tCommon("tryAgain")}
            </button>
          </div>
        )}

        {data && (
          <div className="flex flex-col gap-8">
            {/* Last-7-days caption */}
            <p className="text-xs text-muted-foreground">
              {t("lastWeek")} — depuis le {new Date(data.since).toLocaleDateString("fr-FR")}
            </p>

            {/* Projects table */}
            <section>
              <h2 className="mb-3 text-base font-semibold">{t("projects")}</h2>
              {data.projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("empty")}</p>
              ) : (
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/50 text-left">
                        <th className="px-4 py-2 font-medium">{t("projects")}</th>
                        <th className="px-4 py-2 font-medium">{t("owner")}</th>
                        <th className="px-4 py-2 font-medium text-right">{t("tokensIn")}</th>
                        <th className="px-4 py-2 font-medium text-right">{t("tokensOut")}</th>
                        <th className="px-4 py-2 font-medium text-right">{t("messageCount")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.projects.map((p) => (
                        <tr key={p.id} className="border-b border-border last:border-0">
                          <td className="px-4 py-2 font-medium">{p.name}</td>
                          <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                            {p.ownerId}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {p.lastWeekTokens.in.toLocaleString("fr-FR")}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {p.lastWeekTokens.out.toLocaleString("fr-FR")}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {p.messageCount.toLocaleString("fr-FR")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Tool frequency table */}
            <section>
              <h2 className="mb-3 text-base font-semibold">{t("tools")}</h2>
              {data.toolFrequency.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("empty")}</p>
              ) : (
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/50 text-left">
                        <th className="px-4 py-2 font-medium">{t("toolName")}</th>
                        <th className="px-4 py-2 font-medium text-right">{t("count")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.toolFrequency.map((entry) => (
                        <tr key={entry.tool} className="border-b border-border last:border-0">
                          <td className="px-4 py-2 font-mono text-xs">{entry.tool}</td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {entry.count.toLocaleString("fr-FR")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
