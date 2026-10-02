"use client"

// components/selects/projects/access.tsx
// SelectProjectAccess — a grant's read/write level, with what each level
// allows on the option itself. Used twice: as the level field of
// FormProjectShare (wrapped in FormControl, whose id/aria props it forwards to
// the trigger) and on each existing grant, where it fires on change.

import type { ComponentProps } from "react"
import { useTranslations } from "next-intl"
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  PROJECT_ACCESS,
  isProjectAccess,
  type ProjectAccess,
} from "@/lib/authz/project-access"
import { SelectProjectAccessOption } from "./access-option"

type SelectProjectAccessProps = {
  value: ProjectAccess
  onValueChange: (value: ProjectAccess) => void
  disabled?: boolean
} & Omit<ComponentProps<typeof SelectTrigger>, "children" | "onChange" | "value" | "defaultValue">

export function SelectProjectAccess({
  value,
  onValueChange,
  disabled,
  ...triggerProps
}: SelectProjectAccessProps) {
  const t = useTranslations("projects.share")

  return (
    <Select
      value={value}
      // The two options are the only values the select can produce; anything
      // else is ignored rather than written as a level.
      onValueChange={(v) => {
        if (typeof v === "string" && isProjectAccess(v)) onValueChange(v)
      }}
      disabled={disabled}
    >
      {/* Base UI renders the raw value unless given a labelling function —
          without this the trigger would read "read" / "write". */}
      <SelectTrigger {...triggerProps}>
        <SelectValue>
          {(v: unknown) =>
            typeof v === "string" && isProjectAccess(v) ? t(`level.${v}`) : null
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectProjectAccessOption access={PROJECT_ACCESS.READ} />
        <SelectProjectAccessOption access={PROJECT_ACCESS.WRITE} />
      </SelectContent>
    </Select>
  )
}
