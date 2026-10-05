"use client"

// components/selects/projects/access-option.tsx
// SelectProjectAccessOption — one access level as a select option: the level
// and, under it, what it allows. Shared by the grant form's level field and by
// SelectProjectAccess on an existing grant, so both say the same thing.

import { useTranslations } from "next-intl"
import { SelectItem } from "@/components/ui/select"
import type { ProjectAccess } from "@/lib/authz/project-access"

export function SelectProjectAccessOption({ access }: { access: ProjectAccess }) {
  const t = useTranslations("projects.share")
  return (
    <SelectItem value={access}>
      <span className="flex max-w-64 flex-col whitespace-normal">
        <span>{t(`level.${access}`)}</span>
        <span className="text-xs text-muted-foreground">{t(`levelHint.${access}`)}</span>
      </span>
    </SelectItem>
  )
}
