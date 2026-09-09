"use client"

// components/badges/projects/access.tsx
// BadgeProjectAccess — what the current user may do with a project, resolved
// server-side by lib/authz/project-access.ts and carried on ProjectListItem.
// Owner projects show no badge: "you own this" is the unmarked case.

import { useTranslations } from "next-intl"
import { Eye, Pencil } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { PROJECT_ACCESS_LEVEL } from "@/lib/authz/project-access"
import type { ProjectAccessLevel } from "@/lib/authz/project-access"

interface BadgeProjectAccessProps {
  access: ProjectAccessLevel
}

export function BadgeProjectAccess({ access }: BadgeProjectAccessProps) {
  const t = useTranslations("projects.access")

  if (access === PROJECT_ACCESS_LEVEL.OWNER) return null

  if (access === PROJECT_ACCESS_LEVEL.WRITE) {
    return (
      <Badge variant="secondary">
        <Pencil className="size-3" strokeWidth={1.8} />
        {t("write")}
      </Badge>
    )
  }

  return (
    <Badge variant="outline">
      <Eye className="size-3" strokeWidth={1.8} />
      {t("read")}
    </Badge>
  )
}
