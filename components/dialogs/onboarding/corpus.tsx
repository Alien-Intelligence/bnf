"use client"

// components/dialogs/onboarding/corpus.tsx
// DialogOnboardingCorpus — the Constituer (Step 1) guided intro. Auto-opens once
// per user and is re-openable via the "?" button next to the corpus title.
// Content per design/docs/01 (Corpus intro). Persistence is handled by the
// parent (mark-seen on dismiss); this component is presentational.

import { BarChart3, MessagesSquare, PackageCheck } from "lucide-react"
import { useTranslations } from "next-intl"
import { DialogOnboardingShell } from "./shell"

interface DialogOnboardingCorpusProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DialogOnboardingCorpus({
  open,
  onOpenChange,
}: DialogOnboardingCorpusProps) {
  const t = useTranslations("corpus.intro")

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
          title: t("points.chat.title"),
          text: t("points.chat.text"),
        },
        {
          icon: BarChart3,
          title: t("points.panel.title"),
          text: t("points.panel.text"),
        },
        {
          icon: PackageCheck,
          title: t("points.ingest.title"),
          text: t("points.ingest.text"),
        },
      ]}
    />
  )
}
