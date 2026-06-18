// components/badges/documents/source-badge.tsx
// Renders a document source badge using the SOURCE vocabulary map.
// Falls back to the raw code + muted styling for unknown codes.
// Server component — no event handlers, no hooks.

import { Badge } from "@/components/ui/badge"
import { SOURCE } from "@/models/documents/schema"

interface Props {
  code: string
}

export function BadgeDocumentSource({ code }: Props) {
  const entry = SOURCE[code]

  if (!entry) {
    return (
      <Badge className="bg-muted text-muted-foreground font-normal">
        {code}
      </Badge>
    )
  }

  return (
    <Badge className={`${entry.color} font-normal border-0`}>
      {entry.label}
    </Badge>
  )
}
