"use client"

// components/layouts/workspace/share.tsx
// LayoutWorkspaceShare — the « Partager » entry point beside the project
// switcher. Owns the dialog's open state, the way the switcher owns
// DialogProjectCreate. Rendered by the header only when the server said
// `mayShare` (lib/authz/workspace-header.ts → ProjectPolicy.share), so this
// button and POST /api/projects/:id/shares cannot disagree.

import { useState } from "react"
import { Share2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { DialogProjectShare } from "@/components/dialogs/projects/share"

interface LayoutWorkspaceShareProps {
  projectId: string
  projectName: string
}

export function LayoutWorkspaceShare({ projectId, projectName }: LayoutWorkspaceShareProps) {
  const t = useTranslations("nav")
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Share2 className="size-3.5" />
        {t("share")}
      </Button>
      <DialogProjectShare
        projectId={projectId}
        projectName={projectName}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  )
}
