"use client"

// components/buttons/projects/share.tsx
// ButtonProjectShare — the « Partager » entry point beside the project
// switcher. A button only: the share dialog and its open state live in the
// project shell (LayoutWorkspaceProjectShell), so any entry point can open it.
// Rendered only when the server said `mayShare` (lib/authz/workspace-header.ts
// → ProjectPolicy.share), so it and POST /api/projects/:id/shares cannot
// disagree.

import { Share2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"

export function ButtonProjectShare({ onClick }: { onClick: () => void }) {
  const t = useTranslations("nav")
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <Share2 className="size-3.5" />
      {t("share")}
    </Button>
  )
}
