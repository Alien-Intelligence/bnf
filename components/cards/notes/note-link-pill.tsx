"use client"

// components/cards/notes/note-link-pill.tsx
// NoteLinkPill — the inline rendering of a `[[note:<id>|<label>]]` cross-reference
// inside a note body. A live link is a clickable pill that opens the target note;
// a dead link (target deleted or outside this project) renders greyed and inert
// with an "introuvable" tooltip. Distinct from CitationPill (filled teal, a BnF
// source) so internal navigation reads differently from an external citation.

import { Link2, Unlink } from "lucide-react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"

interface NoteLinkPillProps {
  label: string
  /** Whether the target note is known to exist; false renders a dead link. */
  exists: boolean
  /** Open the target note. Omitted (or undefined) renders a non-navigating pill. */
  onClick?: () => void
}

export function NoteLinkPill({ label, exists, onClick }: NoteLinkPillProps) {
  const t = useTranslations("research.noteLink")

  if (!exists) {
    return (
      <span
        title={t("missing")}
        className="mx-0.5 inline-flex items-center align-middle"
      >
        <Badge className="gap-1 border border-border bg-muted/40 font-mono text-xs text-muted-foreground line-through decoration-muted-foreground/50">
          <Unlink className="size-3" aria-hidden />
          {label}
        </Badge>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={t("open", { label })}
      className="mx-0.5 inline-block align-middle"
    >
      <Badge className="gap-1 border border-brand-teal/40 bg-transparent font-mono text-xs text-brand-teal transition-colors hover:bg-brand-teal/12">
        <Link2 className="size-3" aria-hidden />
        {label}
      </Badge>
    </button>
  )
}
