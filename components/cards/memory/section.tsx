"use client"

// components/cards/memory/section.tsx
// Renders one titled section of the memory snapshot with its items.

import { CardMemoryItem } from "./item"
import type { MemoryItem } from "@/models/memory/schema"

interface Props {
  section: { title: string; items: MemoryItem[] }
  projectId: string
  scope: "corpus" | "research"
}

export function CardMemorySection({ section, projectId, scope }: Props) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {section.title}
      </h4>
      <div className="flex flex-col divide-y divide-border">
        {section.items.map((item) => (
          <CardMemoryItem key={item.id} item={item} projectId={projectId} scope={scope} />
        ))}
      </div>
    </div>
  )
}
