"use client"

// components/selects/projects/access.tsx
// The read/write level of a grant, as an immediate-effect select.
//
// Distinct from the access select inside FormProjectShare: that one is a field
// of a validated submission, so it belongs to the form. This one edits a grant
// that already exists and fires on change — there is nothing to submit, and no
// form to belong to.

import { useTranslations } from "next-intl"
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PROJECT_ACCESS, type ProjectAccess } from "@/lib/authz/project-access"
import { shareProjectSchema } from "@/models/projects/types"
import { SelectProjectAccessOption } from "./access-option"

interface SelectProjectAccessProps {
  value: ProjectAccess
  onValueChange: (value: ProjectAccess) => void
  /** Names the group this grant belongs to, for the accessible label. */
  groupName: string
  disabled: boolean
}

export function SelectProjectAccess({
  value,
  onValueChange,
  groupName,
  disabled,
}: SelectProjectAccessProps) {
  const t = useTranslations("projects.share")

  return (
    <Select
      value={value}
      // The two options are the only values the select can produce; anything
      // else is a bug and the schema says so instead of dropping it.
      onValueChange={(v) => onValueChange(shareProjectSchema.shape.access.parse(v))}
      disabled={disabled}
    >
      {/* Base UI renders the raw value unless given a labelling function —
          without this the trigger would read "read" / "write". */}
      <SelectTrigger
        size="sm"
        className="w-36"
        aria-label={t("changeAccess", { name: groupName })}
      >
        <SelectValue>
          {(v: ProjectAccess) => t(`level.${v}`)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectProjectAccessOption access={PROJECT_ACCESS.READ} />
        <SelectProjectAccessOption access={PROJECT_ACCESS.WRITE} />
      </SelectContent>
    </Select>
  )
}
