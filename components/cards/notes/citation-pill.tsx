"use client"

import { Badge } from "@/components/ui/badge"
import type { ParsedCitation } from "@/lib/citations/syntax"

interface CitationPillProps {
  citation: ParsedCitation
  onClick: (c: ParsedCitation) => void
}

export function CitationPill({ citation, onClick }: CitationPillProps) {
  return (
    <button
      type="button"
      onClick={() => onClick(citation)}
      className="mx-0.5 inline-block align-middle"
    >
      <Badge className="border border-brand-teal/30 bg-brand-teal/12 font-mono text-xs text-brand-teal transition-colors hover:bg-brand-teal/20">
        {citation.label} · f{citation.folio}
      </Badge>
    </button>
  )
}
