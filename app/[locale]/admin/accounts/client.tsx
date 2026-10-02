"use client"

// app/[locale]/admin/accounts/client.tsx
// Admin console — Accounts tab. Every account with its creation date, role, and
// per-account activity totals, plus a CSV export. Header/tabs/main wrapper come
// from the admin layout. Loading / error / empty / data are distinct branches.

import type { UseQueryResult } from "@tanstack/react-query"
import { USER_ROLE, type AdminAccountStat } from "@/models/users/schema"
import { userRoleSchema } from "@/models/users/types"
import { apiUrl } from "@/lib/api-fetch"
import type { AdminAccountsResponse } from "@/app/api/admin/accounts/route"
import { Download } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useAdminAccounts } from "@/hooks/api/admin"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

/** The CSV download — a navigation, not a fetch, so it goes through apiUrl. */
const ACCOUNTS_EXPORT_ENDPOINT = "/api/admin/accounts/export"

export function AdminAccountsClient() {
  const t = useTranslations("admin.accounts")
  const accounts = useAdminAccounts()

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
            window.location.href = apiUrl(ACCOUNTS_EXPORT_ENDPOINT)
          }}
        >
          <Download className="size-4" />
          {t("exportCsv")}
        </Button>
      </div>

      <AccountsBody accounts={accounts} />
    </div>
  )
}

/** loading → error (with retry) → empty → table. */
function AccountsBody({ accounts }: { accounts: UseQueryResult<AdminAccountsResponse> }) {
  const t = useTranslations("admin.accounts")
  const tCommon = useTranslations("common")

  if (accounts.isPending) return <Skeleton className="h-64 rounded-xl" />

  if (accounts.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-destructive">{tCommon("error")}</p>
        <Button variant="outline" size="sm" onClick={() => void accounts.refetch()}>
          {tCommon("tryAgain")}
        </Button>
      </div>
    )
  }

  if (accounts.data.accounts.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>
  }

  return <AccountsTable accounts={accounts.data.accounts} />
}

function AccountsTable({ accounts }: { accounts: AdminAccountStat[] }) {
  const t = useTranslations("admin.accounts")
  const tRole = useTranslations("admin.role")
  const locale = useLocale()
  const fmt = (n: number) => n.toLocaleString(locale)
  // Token totals reach 7-8 digits; compact them ("9,0 M") so the row stays
  // narrow, with the exact value on hover.
  const fmtTokens = (n: number) =>
    n.toLocaleString(locale, { notation: "compact", maximumFractionDigits: 1 })
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(locale)
  // The column is a plain String: an unknown stored role is shown as such,
  // not as a translation key.
  const roleLabel = (role: string): string => {
    const parsed = userRoleSchema.safeParse(role)
    return parsed.success ? tRole(parsed.data) : tRole("unknown")
  }

  return (
    <Card>
      <CardContent className="overflow-x-auto px-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-4 py-2 font-medium">{t("col.name")}</th>
              <th className="px-4 py-2 font-medium">{t("col.role")}</th>
              <th className="px-4 py-2 font-medium">{t("col.createdAt")}</th>
              <th className="px-4 py-2 text-right font-medium">{t("col.projects")}</th>
              <th className="px-4 py-2 text-right font-medium">{t("col.sessions")}</th>
              <th className="px-4 py-2 text-right font-medium">{t("col.messages")}</th>
              <th className="px-4 py-2 text-right font-medium">{t("col.notes")}</th>
              <th className="px-4 py-2 text-right font-medium">{t("col.feedback")}</th>
              <th className="px-4 py-2 text-right font-medium">{t("col.tokensIn")}</th>
              <th className="px-4 py-2 text-right font-medium">{t("col.tokensOut")}</th>
              <th className="px-4 py-2 font-medium">{t("col.lastActive")}</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className="border-b last:border-0">
                <td className="px-4 py-2">
                  <div className="font-medium">{a.name}</div>
                  <div className="text-xs text-muted-foreground">{a.email}</div>
                </td>
                <td className="px-4 py-2">
                  <Badge variant={a.role === USER_ROLE.ADMIN ? "default" : "secondary"}>
                    {roleLabel(a.role)}
                  </Badge>
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                  {fmtDate(a.createdAt)}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{fmt(a.projectCount)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{fmt(a.sessionCount)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{fmt(a.messageCount)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{fmt(a.noteCount)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{fmt(a.feedbackGiven)}</td>
                <td
                  className="px-4 py-2 text-right font-mono tabular-nums"
                  title={fmt(a.tokensIn)}
                >
                  {fmtTokens(a.tokensIn)}
                </td>
                <td
                  className="px-4 py-2 text-right font-mono tabular-nums"
                  title={fmt(a.tokensOut)}
                >
                  {fmtTokens(a.tokensOut)}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                  {a.lastActiveAt ? fmtDate(a.lastActiveAt) : t("never")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}
