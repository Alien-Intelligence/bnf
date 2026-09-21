"use client"

// app/[locale]/admin/projects/client.tsx
// Admin console — Projects tab. The heading, and the table.
//
// The subtitle carries real weight here: it tells the admin why they are seeing
// other people's projects, which is exactly what the user-facing list failed to
// do when it filed them under « Partagés avec moi ».

import { useTranslations } from "next-intl"
import { useAdminProjects } from "@/hooks/api/admin"
import { LayoutAdminProjectsTable } from "@/components/layouts/admin/projects-table"
import type { ProjectListItem } from "@/models/projects/schema"

interface AdminProjectsClientProps {
  initialProjects: ProjectListItem[]
  currentUserId: string
}

export function AdminProjectsClient({
  initialProjects,
  currentUserId,
}: AdminProjectsClientProps) {
  const t = useTranslations("admin.projects")

  // Seeded from the page, so there is no loading state on first paint — the
  // hook exists to keep the table refreshable and consistent with every other
  // admin tab, not because the data is missing.
  const { data, isError, refetch } = useAdminProjects({
    initialData: initialProjects,
  })

  return (
    <div className="flex flex-col gap-8">
      <div className="space-y-1">
        <span className="mono-eyebrow">{t("eyebrow")}</span>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("subtitle")}
        </p>
      </div>

      <LayoutAdminProjectsTable
        projects={data ?? []}
        currentUserId={currentUserId}
        isError={isError}
        onRetry={() => void refetch()}
      />
    </div>
  )
}
