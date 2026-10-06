"use client"

// components/selects/projects/share-group.tsx
// SelectProjectShareGroup — the group a new grant goes to, each option with
// how many people it reaches (a group is chosen for who is in it). The grant
// form's group field; FormControl's id/aria props reach the trigger.

import type { ComponentProps } from "react"
import { useTranslations } from "next-intl"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { GroupListItem } from "@/models/groups/schema"

type SelectProjectShareGroupProps = {
  groups: GroupListItem[]
  value: string | null
  onValueChange: (groupId: string | null) => void
} & Omit<ComponentProps<typeof SelectTrigger>, "children" | "onChange" | "value" | "defaultValue">

export function SelectProjectShareGroup({
  groups,
  value,
  onValueChange,
  className,
  ...triggerProps
}: SelectProjectShareGroupProps) {
  const t = useTranslations("projects.share")
  const label = (g: GroupListItem): string =>
    t("groupOption", { name: g.name, count: g._count.members })

  return (
    <Select
      value={value}
      onValueChange={(v) => onValueChange(typeof v === "string" ? v : null)}
    >
      {/* Full width of its field, not the primitive's w-fit: a long
          « name · N membres » must clip, not run under the level select. */}
      <SelectTrigger className={cn("w-full min-w-0", className)} {...triggerProps}>
        {/* Base UI renders the raw value unless told how to label it — a bare
            SelectValue would show the group's uuid. */}
        <SelectValue className="min-w-0" placeholder={t("groupPlaceholder")}>
          {(v: unknown) => {
            const group = groups.find((g) => g.id === v)
            return group ? label(group) : t("groupPlaceholder")
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {groups.map((g) => (
          <SelectItem key={g.id} value={g.id}>
            {label(g)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
