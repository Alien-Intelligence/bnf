"use client"

// components/layouts/admin/projects-table.tsx
// The admin console's org-wide project table.
//
// Read-only by design: this tab answers "what exists on this instance", not
// "let me change it". Anything an admin wants to do to a project, they do from
// the project itself — which they may open, because admin resolves to `owner`
// in the access table.

import { FolderOpen } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { Link } from "@/i18n/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { LayoutSharedEmptyState } from "@/components/layouts/shared/empty-state"
import { ROUTES } from "@/lib/constants"
import {
  CORPUS_SOURCE_STATE,
  corpusSourceState,
} from "@/lib/authz/corpus-source"
import type { ProjectListItem } from "@/models/projects/schema"

interface LayoutAdminProjectsTableProps {
  projects: ProjectListItem[]
  /** Marks the admin's own rows, so "everyone else's" is legible at a glance. */
  currentUserId: string
  /** A refetch failed. Kept distinct from "empty" — see ui-states.md. */
  isError?: boolean
  onRetry?: () => void
}

export function LayoutAdminProjectsTable({
  projects,
  currentUserId,
  isError,
  onRetry,
}: LayoutAdminProjectsTableProps) {
  const t = useTranslations("admin.projects")
  const tCol = useTranslations("admin.projects.col")
  const tCommon = useTranslations("common")
  const locale = useLocale()

  // An error is not an absence: "no projects on this instance" would be a lie
  // if the refetch simply failed (ui-states.md).
  if (isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-destructive">
        <p className="text-sm">{tCommon("error")}</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {tCommon("tryAgain")}
          </Button>
        )}
      </div>
    )
  }

  if (projects.length === 0) {
    return <LayoutSharedEmptyState icon={FolderOpen} title={t("empty")} />
  }

  return (
    <Card>
      <CardContent className="overflow-x-auto px-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-4 py-2 font-medium">{tCol("name")}</th>
              <th className="px-4 py-2 font-medium">{tCol("owner")}</th>
              <th className="px-4 py-2 text-right font-medium">
                {tCol("docs")}
              </th>
              <th className="px-4 py-2 font-medium">{tCol("state")}</th>
              <th className="px-4 py-2 font-medium">{tCol("source")}</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => {
              const state = corpusSourceState(p)
              const revoked = state === CORPUS_SOURCE_STATE.REVOKED

              return (
                <tr key={p.id} className="border-b last:border-0">
                  <td className="px-4 py-2">
                    <div className="font-medium">{p.name}</div>
                    {p.subtitle && (
                      <div className="text-xs text-muted-foreground">
                        {p.subtitle}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {p.ownerId === currentUserId ? t("you") : p.ownerName}
                  </td>
                  {/* A revoked workspace cannot reach the corpus it points at,
                      so it has no count to report — same rule as the tile. */}
                  <td className="px-4 py-2 text-right font-mono">
                    {revoked ? "—" : p.corpusSize.toLocaleString(locale)}
                  </td>
                  <td className="px-4 py-2">
                    {revoked ? (
                      <Badge variant="outline">{t("revoked")}</Badge>
                    ) : (
                      <Badge variant={p.isIngested ? "default" : "outline"}>
                        {p.isIngested ? t("ingested") : t("notIngested")}
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {p.corpusSourceName ?? t("ownCorpus")}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Link
                      href={ROUTES.rechercher(p.id)}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      {t("open")}
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}
