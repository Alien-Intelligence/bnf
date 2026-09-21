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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PROJECT_ACCESS } from "@/lib/authz/project-access"

interface SelectProjectAccessProps {
  /** The stored level. Prisma types it as a plain string. */
  value: string
  onValueChange: (value: string | null) => void
  /** Names the group this grant belongs to, for the accessible label. */
  groupName: string
  disabled?: boolean
}

export function SelectProjectAccess({
  value,
  onValueChange,
  groupName,
  disabled,
}: SelectProjectAccessProps) {
  const t = useTranslations("projects.share")

  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      {/* Base UI renders the raw value unless given a labelling function —
          without this the trigger would read "read" / "write". */}
      <SelectTrigger
        size="sm"
        className="w-36"
        aria-label={t("changeAccess", { name: groupName })}
      >
        <SelectValue>
          {(v: string | null) =>
            v === PROJECT_ACCESS.WRITE ? t("level.write") : t("level.read")
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={PROJECT_ACCESS.READ}>{t("level.read")}</SelectItem>
        <SelectItem value={PROJECT_ACCESS.WRITE}>{t("level.write")}</SelectItem>
      </SelectContent>
    </Select>
  )
}
