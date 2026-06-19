"use client"

// components/dialogs/onboarding/research.tsx
// DialogOnboardingResearch — the Rechercher (Step 3) guided intro. Auto-opens
// once per user; re-openable via the "?" button. Content per design/docs/01
// (Research intro). Presentational — the parent handles mark-seen on dismiss.

import { BookText, MessagesSquare, Quote } from "lucide-react"
import { useTranslations } from "next-intl"
import { DialogOnboardingShell } from "./shell"

interface DialogOnboardingResearchProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DialogOnboardingResearch({
  open,
  onOpenChange,
}: DialogOnboardingResearchProps) {
  const t = useTranslations("research.intro")

  return (
    <DialogOnboardingShell
      open={open}
      onOpenChange={onOpenChange}
      tag={t("tag")}
      title={t("title")}
      lead={t("lead")}
      points={[
        {
          icon: MessagesSquare,
          title: t("points.ask.title"),
          text: t("points.ask.text"),
        },
        {
          icon: Quote,
          title: t("points.cite.title"),
          text: t("points.cite.text"),
        },
        {
          icon: BookText,
          title: t("points.carnet.title"),
          text: t("points.carnet.text"),
        },
      ]}
    />
  )
}
